import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { startLlmFixture } from './helpers/llm-fixture.js';

const report: { status: string; checks: string[]; error?: string } = { status: 'RUNNING', checks: [] };
const harness = await startHarness();

let seededIndex = 0;
async function seedApp(name: string, tags: string[], searchText: string) {
  const index = 400 + (++seededIndex);
  const seeded = await seedTagCatalog(harness.db, harness.config.audience, tags, index);
  const manifest = {
    ...seeded.source,
    name,
    summary: `用于智能查找回归的 ${name}。`,
    tags,
    entries: [{ id: 'web', kind: 'web', label: '打开平台', url: `https://example.invalid/smart-search/${index}` }],
    primaryEntry: 'web',
  };
  await harness.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [seeded.snapshotId, JSON.stringify(manifest), searchText]);
  return { id: seeded.appId, name };
}

const daily = await seedApp('工时日报助手', ['工时日报', '日报模板'], '工时 日报 企业微信 工作记录 汇总');
const knowledge = await seedApp('知识库整理', ['知识整理'], '知识 整理 文档 归档');
const meeting = await seedApp('会议纪要生成器', ['会议纪要'], '会议 纪要 语音转文字');

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const errors: string[] = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));

  // Default homepage is smart search; rail highlights it and the URL stays clean.
  await page.goto(harness.origin);
  await page.getByRole('heading', { name: '你想完成什么工作？', exact: true }).waitFor();
  assert.equal(await page.getByTestId('tab-search').getAttribute('aria-current'), 'page');
  assert.equal(new URL(page.url()).searchParams.has('discover'), false, 'the smart-search default keeps the URL free of a discover parameter');
  assert.equal(await page.getByTestId('tab-catalog').getAttribute('aria-current'), null);
  report.checks.push('default-home');

  // URL semantics for the other discovery tabs.
  await page.goto(`${harness.origin}/?discover=random`);
  await page.getByTestId('wheel-current').waitFor();
  await page.goto(`${harness.origin}/?discover=catalog`);
  await page.getByTestId('app-card').first().waitFor();
  await page.goto(harness.origin);
  await page.getByRole('heading', { name: '你想完成什么工作？', exact: true }).waitFor();
  report.checks.push('url-semantics');

  // A natural-language task returns basic-mode results ranked by matched terms.
  const composer = page.getByRole('textbox', { name: '描述你想完成的任务' });
  assert.equal(await composer.getAttribute('maxlength'), '200', 'the composer caps input at the server limit');
  await composer.fill('把已有工作记录整理成日报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.smart-search .recommendation').first().waitFor();
  await page.getByText('当前为基础检索：按关键词匹配，不代表对任务的理解。').waitFor();
  assert.equal(await page.getByText('上一轮结果', { exact: true }).count(), 0, 'fresh results are not marked as the previous round');
  const names = () => page.locator('.smart-search [data-active] .recommendation').evaluateAll(nodes => nodes.map(node => node.querySelector('.app-title')?.textContent?.trim()));
  assert.deepEqual(await names(), [daily.name], 'the best match renders first and secondary matches stay unmounted until expanded');
  const firstReason = page.locator('.smart-search [data-active] .recommendation').first().locator('.reason-block');
  assert.match(await firstReason.innerText(), /命中：工时日报、日报模板、工时日报助手。/);
  assert.equal(await page.locator('.smart-search .recommendation').filter({ hasText: meeting.name }).count(), 0, 'unmatched apps are not padded into results');
  assert.equal(await page.getByRole('button', { name: '其他匹配应用（1）', exact: true }).count(), 1, 'secondary matches stay collapsed behind the toggle');
  assert.equal(await page.locator('.smart-search [data-active] .recommendation').count(), 1, 'collapsed matches are not mounted until expanded');
  await page.getByRole('button', { name: '其他匹配应用（1）', exact: true }).click();
  assert.equal(await page.locator('.smart-search [data-active] .recommendation').count(), 2);
  assert.deepEqual(await names(), [daily.name, knowledge.name], 'matched apps rank by matched-term count');
  await page.getByRole('button', { name: '收起其他匹配应用', exact: true }).click();
  report.checks.push('basic-search-ranking');

  // A query with no usable keyword answers with the honest empty state, not filler.
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await composer.fill('图');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.smart-search .msg-text').filter({ hasText: '没有匹配结果' }).waitFor();
  report.checks.push('single-keyword-honesty');

  // An unfinished draft marks the visible results as the previous round.
  await composer.fill('另一个任务');
  await page.getByText('上一轮结果', { exact: true }).waitFor();
  report.checks.push('stale-draft-tag');

  // No-match queries answer honestly with recovery actions instead of filler.
  await composer.fill('完全不存在的需求词组');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.smart-search .msg-text').filter({ hasText: '没有匹配结果' }).last().waitFor();
  report.checks.push('no-match-honesty');

  // Errors surface with a retry that recovers.
  await page.route('**/api/apps/smart-search*', route => route.abort('failed'));
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await composer.fill('整理日报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('暂时无法连接应用广场服务，请稍后重试。').waitFor();
  await page.unroute('**/api/apps/smart-search*');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('.smart-search .recommendation').first().waitFor();
  report.checks.push('error-retry');

  // Waiting states are cancellable and a cancelled request never lands.
  let releaseSearch: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { releaseSearch = resolve; });
  await page.route('**/api/apps/smart-search*', async route => { await gate; await route.continue(); });
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await composer.fill('整理日报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('正在检索适用应用…').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByText('正在检索适用应用…').count(), 0, 'cancelling dismisses the waiting state');
  releaseSearch!();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.smart-search .recommendation').count(), 0, 'a cancelled request must not append results');
  await page.unroute('**/api/apps/smart-search*');
  report.checks.push('cancel-waiting');

  // Tab switches keep the conversation alive, its scroll position and the URL in sync.
  await composer.fill('整理日报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.smart-search [data-active] .recommendation').first().waitFor();
  const thread = page.locator('.smart-search .thread');
  await thread.evaluate(el => { el.scrollTop = 120 });
  const threadScroll = await thread.evaluate(el => el.scrollTop);
  assert.ok(threadScroll > 0, 'the thread is scrollable after results');
  await page.getByTestId('tab-catalog').click();
  await page.locator('.catalog-results').getByTestId('app-card').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('discover'), 'catalog');
  await page.getByTestId('tab-search').click();
  await page.locator('.smart-search [data-active] .recommendation').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.has('discover'), false, 'returning to smart search clears the discover parameter');
  assert.equal(await page.locator('.smart-search .result-task').last().innerText(), '整理日报', 'the conversation survives switching tabs');
  assert.equal(await thread.evaluate(el => el.scrollTop), threadScroll, 'the thread scroll position survives a tab round trip');
  report.checks.push('tab-switch-preserves-thread');

  // Detail opens over the thread and returns to it.
  await page.locator('.smart-search [data-active] .recommendation').first().getByTestId('card-title').click();
  await page.getByTestId('app-detail').waitFor();
  assert.equal(await page.getByTestId('return-discovery').innerText(), '← 返回智能查找');
  await page.getByTestId('return-discovery').click();
  await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.smart-search .result-task').last().innerText(), '整理日报', 'the conversation survives a detail round trip');
  assert.equal(await thread.evaluate(el => el.scrollTop), threadScroll, 'the thread scroll position survives a detail round trip');
  report.checks.push('detail-round-trip');

  // A tag on a result jumps into the filtered catalog and re-choosing it keeps the filter.
  await page.locator('.smart-search [data-active] .recommendation').first().getByRole('button', { name: '按标签 工时日报 筛选' }).click();
  await page.locator('.catalog-results').getByTestId('app-card').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('discover'), 'catalog');
  assert.equal(await page.getByTestId('tag-chip').filter({ hasText: '工时日报' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.locator('.catalog-results').getByTestId('app-card').evaluateAll(cards => cards.map(card => card.dataset.appId)), [daily.id]);
  await page.getByTestId('tab-search').click();
  await page.locator('.smart-search [data-active] .recommendation').first().getByRole('button', { name: '按标签 工时日报 筛选' }).click();
  await page.locator('.catalog-results').getByTestId('app-card').first().waitFor();
  assert.equal(await page.getByTestId('tag-chip').filter({ hasText: '工时日报' }).getAttribute('aria-pressed'), 'true', 'choosing an already-active tag keeps the filter applied');
  assert.deepEqual(await page.locator('.catalog-results').getByTestId('app-card').evaluateAll(cards => cards.map(card => card.dataset.appId)), [daily.id]);
  report.checks.push('tag-jumps-to-catalog');

  // Focus revalidation drops results whose access was revoked while the page was idle.
  await page.getByTestId('tab-search').click();
  await page.locator('.smart-search [data-active] .recommendation').first().waitFor();
  await page.route(`**/api/apps/${daily.id}`, route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'APP_NOT_FOUND', message: '应用不存在。' } }) }));
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(id => !document.querySelector(`.smart-search [data-active] [data-app-id="${id}"]`), daily.id);
  assert.equal(await page.locator(`.smart-search [data-active] [data-app-id="${knowledge.id}"]`).count(), 1, 'remaining results stay visible');
  await page.unroute(`**/api/apps/${daily.id}`);
  report.checks.push('focus-revalidates-results');

  // AI mode: a configured model ranks results, writes reasons and may ask one
  // clarifying question; the follow-up reply continues the original task.
  let llm: Awaited<ReturnType<typeof startLlmFixture>> | null = null;
  let aiHarness: Awaited<ReturnType<typeof startHarness>> | null = null;
  let aiPage: Awaited<ReturnType<typeof browser.newPage>> | null = null;
  try {
    llm = await startLlmFixture();
    aiHarness = await startHarness(1, 'memory://', { smartSearchAi: { baseUrl: llm.url, model: 'deepseek-flash', apiKey: 'fixture-key', timeoutMs: 3000 } });
    const aiSeeded = await seedTagCatalog(aiHarness.db, aiHarness.config.audience, ['工时日报'], 500);
    const aiManifest = { ...aiSeeded.source, name: '工时日报助手', summary: '按可核验事实整理、归档企业微信工时日报。', tags: ['工时日报'], entries: [{ id: 'web', kind: 'web', label: '打开平台', url: 'https://example.invalid/ai' }], primaryEntry: 'web' };
    await aiHarness.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [aiSeeded.snapshotId, JSON.stringify(aiManifest), '日报 工时 记录 整理 企业微信']);
    // An unrelated recent app must never pad AI or degraded results.
    const aiOther = await seedTagCatalog(aiHarness.db, aiHarness.config.audience, ['会议纪要'], 501);
    const otherManifest = { ...aiOther.source, name: '纪要生成工具', summary: '生成会议纪要。', tags: ['会议纪要'] };
    await aiHarness.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [aiOther.snapshotId, JSON.stringify(otherManifest), '会议 纪要 语音']);
    aiPage = await browser.newPage();
    aiPage.on('pageerror', error => errors.push(error.message));
    const aiComposer = aiPage.getByRole('textbox', { name: '描述你想完成的任务' });
    await aiPage.goto(aiHarness.origin);
    llm.state.reply = () => ({ picks: [{ id: aiSeeded.appId, why: '按可核验事实整理并归档日报。' }], question: null });
    await aiComposer.fill('把工作记录变成日报');
    await aiPage.getByRole('button', { name: '发送', exact: true }).click();
    await aiPage.getByText('由内网智能服务理解任务后推荐；理由依据应用资料，仍请以详情为准。').waitFor();
    await aiPage.getByText('按可核验事实整理并归档日报。').waitFor();
    assert.equal(await aiPage.locator(`.smart-search [data-active] [data-app-id="${aiSeeded.appId}"]`).count(), 1);
    assert.equal(llm.state.requests.at(-1)!.body.model, 'deepseek-flash');

    llm.state.reply = () => ({ picks: [], question: '已有工作记录，还是需要先收集？' });
    await aiPage.getByRole('button', { name: '新对话', exact: true }).click();
    await aiComposer.fill('帮我整理日报');
    await aiPage.getByRole('button', { name: '发送', exact: true }).click();
    await aiPage.getByText('已有工作记录，还是需要先收集？').waitFor();
    assert.equal(await aiPage.getByText('没有匹配结果').count(), 0, 'a clarifying question is not presented as a concluded empty search');
    llm.state.reply = () => ({ picks: [{ id: aiSeeded.appId, why: '整理已有记录即可。' }], question: null });
    await aiComposer.fill('已有工作记录');
    await aiPage.getByRole('button', { name: '发送', exact: true }).click();
    await aiPage.locator('.smart-search [data-active] .recommendation').first().waitFor();
    const lastQuery = llm.state.requests.at(-1)!.body.messages[1].content;
    assert.match(lastQuery, /帮我整理日报/, 'the follow-up keeps the original task');
    assert.match(lastQuery, /补充：已有工作记录/, 'the follow-up carries the answer');

    // Model output (reasons and questions) is untrusted: it must render as plain text.
    llm.state.reply = () => ({ picks: [{ id: aiSeeded.appId, why: '<img src=x onerror="window.__plazaXss=1">整理工时日报。' }], question: '需要 <script>window.__plazaXss=2</script> 补充材料吗？' });
    await aiPage.getByRole('button', { name: '新对话', exact: true }).click();
    await aiComposer.fill('整理日报');
    await aiPage.getByRole('button', { name: '发送', exact: true }).click();
    await aiPage.getByText('<img src=x onerror="window.__plazaXss=1">整理工时日报。').waitFor();
    await aiPage.getByText('需要 <script>window.__plazaXss=2</script> 补充材料吗？').waitFor();
    assert.equal(await aiPage.evaluate(() => (window as any).__plazaXss), undefined, 'model output never executes as HTML');

    // Model failure degrades to keyword results: the model is really called, fails,
    // and only the keyword-matching app is returned — no unrelated padding.
    llm.state.status = 503;
    const requestsBefore = llm.state.requests.length;
    await aiPage.getByRole('button', { name: '新对话', exact: true }).click();
    await aiComposer.fill('工时日报');
    await aiPage.getByRole('button', { name: '发送', exact: true }).click();
    await aiPage.getByText('当前为基础检索：按关键词匹配，不代表对任务的理解。').waitFor();
    assert.equal(llm.state.requests.length, requestsBefore + 1, 'the failed model call actually happened');
    assert.equal(await aiPage.locator('.smart-search [data-active] .recommendation').count(), 1, 'degraded results contain only the keyword hit');
    assert.equal(await aiPage.locator(`.smart-search [data-active] [data-app-id="${aiOther.appId}"]`).count(), 0, 'unrelated recent apps are not padded in');
    report.checks.push('ai-mode');
  } finally {
    await aiPage?.close();
    await aiHarness?.close();
    await llm?.close();
  }

  // Super administrators configure the system prompt in the admin center; the change
  // takes effect for subsequent searches and members never see the page.
  const promptLlm = await startLlmFixture();
  const promptHarness = await startIdentityHarness('', { superAdminAccount: 'fixture.admin', smartSearchAi: { baseUrl: promptLlm.url, model: 'deepseek-flash', apiKey: 'fixture-key', timeoutMs: 3000 } });
  let promptPage: Awaited<ReturnType<typeof browser.newPage>> | null = null;
  let memberPage: Awaited<ReturnType<typeof browser.newPage>> | null = null;
  try {
    const promptSeeded = await seedTagCatalog(promptHarness.db, promptHarness.config.audience, ['工时日报'], 600);
    const promptManifest = { ...promptSeeded.source, name: '工时日报助手', summary: '整理并归档工时日报。', tags: ['工时日报'] };
    await promptHarness.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [promptSeeded.snapshotId, JSON.stringify(promptManifest), '日报 工时 整理']);
    promptPage = await browser.newPage();
    promptPage.on('pageerror', error => errors.push(error.message));
    await promptPage.goto(`${promptHarness.origin}/fixture/portal`);
    await promptPage.getByRole('button', { name: '以测试名册管理员进入', exact: true }).click();
    await promptPage.getByRole('button', { name: '退出广场', exact: true }).waitFor();
    await promptPage.goto(`${promptHarness.origin}/?space=smart-search`);
    await promptPage.getByRole('heading', { name: '系统提示词', exact: true }).waitFor();
    assert.match(await promptPage.locator('.status-chip').innerText(), /使用默认/);
    const editor = promptPage.getByRole('textbox', { name: '系统提示词模板正文' });
    await editor.fill('浏览器自定义提示：只输出空 JSON。');
    await promptPage.getByTestId('prompt-save').click();
    await promptPage.getByText('提示词已保存，后续检索立即生效。').waitFor();
    assert.match(await promptPage.locator('.status-chip').innerText(), /已自定义/);
    promptLlm.state.reply = () => ({ picks: [{ id: promptSeeded.appId, why: '自定义理由。' }], question: null });
    await promptPage.goto(promptHarness.origin);
    await promptPage.getByRole('textbox', { name: '描述你想完成的任务' }).fill('整理日报');
    await promptPage.getByRole('button', { name: '发送', exact: true }).click();
    await promptPage.locator('.smart-search [data-active] .recommendation').first().waitFor();
    assert.equal(promptLlm.state.requests.at(-1)!.body.messages[0].content, '浏览器自定义提示：只输出空 JSON。', 'a saved prompt reaches the model call');
    await promptPage.goto(`${promptHarness.origin}/?space=smart-search`);
    await promptPage.getByTestId('prompt-reset').click();
    await promptPage.locator('.el-message-box').getByRole('button', { name: '恢复默认', exact: true }).click();
    await promptPage.getByText('已恢复默认提示词，后续检索立即使用默认模板。').waitFor();
    assert.match(await promptPage.locator('.status-chip').innerText(), /使用默认/);

    memberPage = await browser.newPage();
    memberPage.on('pageerror', error => errors.push(error.message));
    await memberPage.goto(`${promptHarness.origin}/fixture/portal`);
    await memberPage.getByRole('button', { name: '以测试普通成员进入', exact: true }).click();
    await memberPage.getByRole('button', { name: '退出广场', exact: true }).waitFor();
    assert.equal(await memberPage.getByRole('link', { name: '智能查找', exact: true }).count(), 0, 'members do not see the admin entry');
    await memberPage.goto(`${promptHarness.origin}/?space=smart-search`);
    await memberPage.getByRole('heading', { name: '当前身份没有此页面权限', exact: true }).waitFor();
    report.checks.push('prompt-config');
  } finally {
    await promptPage?.close();
    await memberPage?.close();
    await promptHarness.close();
    await promptLlm.close();
  }

  assert.deepEqual(errors, []);
  report.status = 'PASS';
  console.log(JSON.stringify({ status: 'PASS', checks: report.checks, boundary: 'loopback fixtures only' }));
} catch (error) {
  report.status = 'FAIL';
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await harness.close();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/smart-search-browser.json', JSON.stringify(report, null, 2));
}
