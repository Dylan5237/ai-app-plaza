import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startManagementFixture } from './helpers/management-fixture.js';

await mkdir('artifacts/admin-basics-browser', { recursive: true });
const h = await startManagementFixture();
const report: any = { checks: [], errors: [], externalRequests: [], boundary: 'Isolated real Fastify/PGlite and GitLab protocol fixture; no company GitLab or production writes' };
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (/^https?:/.test(url.protocol) && url.origin !== h.origin) { report.externalRequests.push(url.href); return route.abort(); }
  return route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => report.errors.push(error.message));
const appId = h.seeds.update.appId;
const read = async (path: string) => (await context.request.get(h.origin + path)).json();
const lifecycle = async (action: string) => {
  const current = await read(`/api/management/apps/${appId}`);
  const response = await context.request.post(`${h.origin}/api/management/apps/${appId}/lifecycle`, { data: { action, expectedAppRevision: current.revision, expectedLifecycleRevision: current.lifecycle.revision } });
  assert.equal(response.status(), 200, await response.text());
};
async function confirmDialog(label: string) { await page.locator('.el-message-box').getByRole('button', { name: label, exact: true }).click(); }
try {
  await page.goto(h.origin + '/admin');
  await page.getByTestId(`management-edit-${appId}`).waitFor();
  assert.equal(await page.getByTestId('management-table').locator('.el-tag').first().innerText(), '已上架');
  await page.getByTestId('management-create').click();
  await page.getByTestId('copy-publish-prompt').waitFor();
  assert.equal(await page.getByTestId('update-target').count(), 0);
  await page.keyboard.press('Escape');
  await page.getByTestId('publish-contract-dialog').waitFor({ state: 'hidden' });
  report.checks.push('new application reuses the existing first publication prompt');

  await page.getByTestId(`management-visibility-${appId}`).click(); await confirmDialog('确认下架');
  await page.getByText('应用已下架', { exact: true }).waitFor();
  assert.equal((await read('/api/apps?pageSize=100')).items.some((item: any) => item.id === appId), false);
  assert.equal((await context.request.get(`${h.origin}/api/apps/${appId}`)).status(), 404);
  assert.equal((await context.request.get(`${h.origin}/api/apps/${appId}/instructions/agent`)).status(), 404);
  await page.getByTestId(`management-detail-${appId}`).click();
  await page.getByTestId('app-detail').waitFor();
  await page.getByTestId('use-agent').click();
  await page.getByTestId('copy-agent-prompt').waitFor();
  await page.keyboard.press('Escape'); await page.getByTestId('agent-instruction-dialog').waitFor({ state: 'hidden' });
  await page.getByTestId('publish-update').click(); await page.getByTestId('update-target').waitFor();
  await page.keyboard.press('Escape'); await page.getByTestId('publish-contract-dialog').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape'); await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  report.checks.push('offline application is hidden from public list/direct detail/instructions, while backend reuses full detail, Agent and update dialogs');

  const before = await h.service.app(appId, { includeHidden: true });
  const project = h.gitlab.state.projects.get(Number(before.source.projectId))!;
  const oldTree = project.commits.get(before.source.commitSha)!.files;
  const oldSource = oldTree.get('src/keep-source.ts');
  assert.ok(oldSource);
  const writesBefore = h.gitlab.state.writes.length;
  await page.getByTestId(`management-edit-${appId}`).click();
  await page.getByTestId('editor-summary').fill('在后台修改资料，并保留原有源码与版本历史。');
  assert.equal(await page.getByTestId('editor-version').inputValue(), '1.1.1');
  await page.getByTestId('editor-version').fill('1.0.1');
  await page.getByTestId('editor-save').click();
  await page.getByText('同一托管应用的新预览必须使用高于此前候选的 projectVersion；GitLab tag 和 Release 不会移动或覆盖。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('editor-version').isDisabled(), false);
  assert.equal(h.gitlab.state.writes.length, writesBefore);
  await page.getByTestId('editor-version').fill('1.1.1');

  await page.getByRole('tab', { name: '入口与完整说明' }).click();
  await page.getByTestId('editor-doc-README.md').fill('# 后台修改的完整介绍\n\n保留源码，确认后更新广场。');
  await page.getByTestId('editor-save').click();
  await page.getByTestId('update-preview').waitFor();
  assert.equal((await h.service.app(appId, { includeHidden: true })).version, '1.0.0');
  const publicationId = new URL(page.url()).hash.replace('#publish=', '');
  const preview = await h.service.managementPublication(publicationId);
  assert.equal(preview.preview?.manifest.summary, '在后台修改资料，并保留原有源码与版本历史。');
  const newTree = project.commits.get(preview.preview!.source.commitSha)!.files;
  assert.deepEqual(newTree.get('src/keep-source.ts'), oldSource);
  assert.equal(project.tags.get('v1.0.0'), before.source.commitSha);
  assert.equal(project.tags.has('v1.1.0'), true);
  assert.equal(h.gitlab.state.writes.slice(writesBefore).filter(item => item.path.includes('/projects') && !item.path.includes('/repository/') && !item.path.includes('/releases')).length, 0);
  await page.getByTestId('confirm-publication').click(); await page.getByText('应用已更新', { exact: true }).waitFor();
  const updated = await h.service.app(appId, { includeHidden: true });
  assert.equal(updated.version, '1.1.1'); assert.equal(updated.id, before.id);
  assert.equal(updated.lifecycle?.status, 'offline');
  assert.equal((await context.request.get(`${h.origin}/api/apps/${appId}`)).status(), 404);
  await page.getByTestId('return-management').click(); await page.waitForURL(h.origin + '/admin');
  report.checks.push('manual manifest and Markdown edits create a new GitLab commit/tag/Release and original update preview; source/history stay intact, old snapshot stays until confirmation and offline status survives confirmation');

  await page.getByTestId(`management-visibility-${appId}`).click(); await confirmDialog('确认上架');
  await page.getByText('应用已上架', { exact: true }).waitFor();
  assert.equal((await read(`/api/apps/${appId}`)).version, '1.1.1');
  await page.getByTestId(`management-delete-${appId}`).click(); await confirmDialog('移入回收站');
  await page.getByText('应用已移入回收站', { exact: true }).waitFor();
  await page.getByTestId(`management-detail-${appId}`).waitFor({ state: 'hidden' });
  assert.equal((await context.request.get(`${h.origin}/api/apps/${appId}`)).status(), 404);
  await page.getByTestId('management-tab-trash').click(); await page.getByTestId(`management-restore-${appId}`).waitFor();
  await page.getByTestId(`management-detail-${appId}`).click(); await page.getByTestId('app-detail').waitFor();
  assert.equal(await page.getByTestId('publish-update').count(), 0);
  await page.keyboard.press('Escape'); await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await page.getByTestId(`management-restore-${appId}`).click(); await confirmDialog('恢复为下架');
  await page.getByText('应用已恢复，当前为下架状态', { exact: true }).waitFor();
  await page.getByTestId('management-tab-apps').click(); await page.getByTestId(`management-edit-${appId}`).waitFor();
  assert.equal((await read(`/api/management/apps/${appId}`)).lifecycle.status, 'offline');
  assert.equal((await context.request.get(`${h.origin}/api/apps/${appId}`)).status(), 404);
  assert.ok(project.commits.has(before.source.commitSha));
  report.checks.push('online/delete/trash/restore work in the browser; restore keeps application offline and preserves GitLab source/history');

  // A lost successful editor response must replay the exact UUID and body, without duplicate GitLab writes.
  await page.getByTestId(`management-edit-${appId}`).click();
  await page.getByTestId('editor-summary').fill('保存响应丢失后使用原请求恢复。');
  const requests: Array<{ key: string | undefined; body: string | null }> = [];
  let dropped = false;
  await page.route(`**/api/management/apps/${appId}/editor`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (!dropped) { dropped = true; await route.fetch(); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByTestId('editor-save').click(); await page.getByRole('button', { name: '重试本次保存' }).waitFor();
  assert.equal(await page.getByTestId('editor-summary').isDisabled(), true);
  const writesAfterLoss = h.gitlab.state.writes.length;
  await page.getByTestId('editor-save').click(); await page.getByTestId('update-preview').waitFor();
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]); assert.ok(requests[0]!.key);
  assert.equal(h.gitlab.state.writes.length, writesAfterLoss);
  await page.unroute(`**/api/management/apps/${appId}/editor`);
  report.checks.push('lost editor response locks the draft and retries the same key/payload, recovering the same preview with zero extra GitLab writes');
  await page.getByTestId('return-management').click(); await page.waitForURL(h.origin + '/admin');
  await page.screenshot({ path: 'artifacts/admin-basics-browser/desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByTestId(`management-edit-${appId}`).click(); await page.getByTestId('editor-summary').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/admin-basics-browser/mobile-editor.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.status = 'PASS';
} catch (error: any) {
  report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1;
  await page.screenshot({ path: 'artifacts/admin-basics-browser/failure.png', fullPage: true, animations: 'disabled' }).catch(() => {});
} finally {
  await context.close(); await browser.close(); await h.close();
  await writeFile('artifacts/admin-basics-browser/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
