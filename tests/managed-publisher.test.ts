import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../server/domain/database.js";
import { createManagedPublisher } from "../server/domain/managed-publisher.js";
import { createService } from "../server/domain/service.js";
import { DomainError } from "../server/domain/errors.js";
import { manifest } from "./helpers/gitlab-fixture.js";
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from "./helpers/managed-gitlab-fixture.js";

const SECRET = "managed-publisher-test-secret-with-at-least-32-bytes";

async function startManagedHarness() {
  const db = await openDatabase({ path: "memory://" });
  const gitlab = await startManagedGitLabFixture();
  const service = createService({ db, gitlabUrl: gitlab.url, publicOrigin: "http://127.0.0.1:3000", secret: SECRET, audience: "测试内网" });
  const publisher = createManagedPublisher({
    db,
    gitlabUrl: gitlab.url,
    gitlabToken: MANAGED_GITLAB_TOKEN,
    groupId: "63",
    secret: SECRET,
    service,
  });
  return { db, gitlab, service, publisher, close: async () => { await db.close(); await gitlab.close(); } };
}

function publishKey(): string { return randomBytes(32).toString("base64url"); }

function makeBundle(version = "1.0.0", summary = "将 Word 转为 Markdown 并整理文档。", extraFiles: Array<{ path: string; text: string }> = []) {
  const appManifest = {
    ...manifest(1),
    appKey: "sample-1",
    projectVersion: version,
    summary,
    docs: { readme: "README.md", usage: "docs/usage-1.md" },
  };
  const files = [
    { path: "ai-app.json", text: JSON.stringify(appManifest) },
    { path: "README.md", text: "# 文档助手\n\n用于受控测试的应用说明。" },
    { path: "docs/usage-1.md", text: `# 使用说明\n\n${summary}` },
    { path: "docs/agent-1.md", text: "# Agent 接入说明\n\n核对环境和授权后执行最小验证。" },
    ...extraFiles,
  ];
  return {
    appKey: "sample-1",
    manifestPath: "ai-app.json",
    files: files.map(({ path, text }) => ({ path, content: Buffer.from(text, "utf8").toString("base64") })),
  };
}

function writeCount(harness: Awaited<ReturnType<typeof startManagedHarness>>, suffix: string): number {
  return harness.gitlab.state.writes.filter(item => item.path.endsWith(suffix)).length;
}

function assertDomainError(error: unknown, code: string): asserts error is DomainError {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, code);
}

test("managed first publish previews for manual confirmation, then updates the same app and idempotent retry creates no duplicate GitLab objects", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  const key = publishKey();
  const idem = "first-managed-upload-0001";
  const initialBundle = makeBundle();
  const first = await h.publisher.submit(initialBundle, key, idem);
  assert.equal(first.status, "preview_ready");
  assert.equal(first.sourceUploaded, true);
  assert.ok(first.managedAppId);
  assert.equal(first.change?.kind, "create");
  const appId = first.preview!.id;
  assert.equal(await h.publisher.findByAppId(appId), undefined, "a preview candidate is not yet a catalog-owned app");
  const bindingRow = (await h.db.query<{ publish_key_digest: string }>("SELECT publish_key_digest FROM managed_app_bindings WHERE id = $1", [first.managedAppId])).rows[0]!;
  assert.match(bindingRow.publish_key_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(bindingRow.publish_key_digest, key, "only a keyed digest, never the client secret, is persisted");
  const operationRow = (await h.db.query<Record<string, unknown>>("SELECT * FROM managed_publish_operations WHERE binding_id = $1", [first.managedAppId])).rows[0]!;
  assert.equal("files" in operationRow, false, "bundle contents are not persisted");

  const project = h.gitlab.state.projects.get(100)!;
  assert.equal(project.visibility, "private");
  assert.equal(project.namespace.id, 63);
  assert.equal(project.initialize_with_readme, false);
  assert.equal(project.builds_access_level, "disabled");
  assert.equal(project.shared_runners_enabled, false);
  assert.equal(project.branches.size, 1, "the candidate is written to its isolated plaza-upload branch");
  const writeCounts = [
    h.gitlab.state.projects.size,
    writeCount(h, "/repository/commits"),
    writeCount(h, "/repository/tags"),
    writeCount(h, "/releases"),
  ];

  const confirmed = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  assert.equal(confirmed.status, "registered");
  assert.equal(confirmed.appId, appId);
  assert.deepEqual(await h.publisher.findByAppId(appId), { managedAppId: first.managedAppId, projectId: "100", appKey: "sample-1" });
  const repeated = await h.publisher.submit(initialBundle, key, idem);
  assert.equal(repeated.status, "registered");
  assert.deepEqual([
    h.gitlab.state.projects.size,
    writeCount(h, "/repository/commits"),
    writeCount(h, "/repository/tags"),
    writeCount(h, "/releases"),
  ], writeCounts);

  const updated = await h.publisher.submit({
    ...makeBundle("1.1.0", "文档助手新增批量转换和校验说明。"),
    managedAppId: first.managedAppId,
    expectedAppRevision: 1,
  }, key, "sample-update-operation-0001");
  assert.equal(updated.status, "preview_ready");
  assert.equal(updated.preview?.id, appId);
  assert.equal(updated.preview?.revision, 2);
  assert.equal(updated.change?.kind, "update");
  await assert.rejects(
    h.publisher.submit({ ...makeBundle("1.1.0", "文档助手新增批量转换和校验说明。"), expectedAppRevision: 1 }, key, "sample-update-operation-0001"),
    error => { assertDomainError(error, "MANAGED_APP_OWNER_REQUIRED"); return true; },
  );
  const updatedConfirmed = await h.service.confirm(updated.id, updated.ticket, { revision: updated.revision, digest: updated.digest! });
  assert.equal(updatedConfirmed.appId, appId);
  const current = await h.service.app(appId);
  assert.equal(current.revision, 2);
  assert.equal(current.version, "1.1.0");
  assert.equal(current.source.projectId, "100");
  assert.equal(await h.publisher.findByAppId(appId) !== undefined, true);
});

test("owner mismatch, reused idempotency key with different content, and dangerous paths cause no GitLab writes", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  const key = publishKey();
  const bundle = makeBundle();
  const first = await h.publisher.submit(bundle, key, "same-request-key-0001");
  const writesBefore = h.gitlab.state.writes.length;

  await assert.rejects(
    h.publisher.submit(makeBundle("1.0.0", "不同的源码内容。"), key, "same-request-key-0001"),
    error => { assertDomainError(error, "IDEMPOTENCY_CONFLICT"); return true; },
  );
  await assert.rejects(
    h.publisher.submit({ ...bundle, managedAppId: first.managedAppId }, publishKey(), "wrong-owner-operation-0001"),
    error => { assertDomainError(error, "MANAGED_APP_OWNER_REQUIRED"); return true; },
  );
  const dangerous = makeBundle();
  dangerous.files.push({ path: ".env", content: Buffer.from("PRIVATE_TOKEN=do-not-upload").toString("base64") });
  await assert.rejects(
    h.publisher.submit(dangerous, publishKey(), "dangerous-bundle-operation-0001"),
    error => { assertDomainError(error, "VALIDATION_FAILED"); return true; },
  );
  const leakedToken = makeBundle();
  leakedToken.files.find(file => file.path === "README.md")!.content = Buffer.from(`example=${MANAGED_GITLAB_TOKEN}`).toString("base64");
  await assert.rejects(
    h.publisher.submit(leakedToken, publishKey(), "token-marker-bundle-operation-01"),
    error => {
      assertDomainError(error, "VALIDATION_FAILED");
      assert.equal(error.message.includes(MANAGED_GITLAB_TOKEN), false);
      return true;
    },
  );
  assert.equal(h.gitlab.state.writes.length, writesBefore);
});

test("commit response loss is recovered from the operation branch without creating a second commit", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  h.gitlab.state.dropNextCommitResponse = true;
  const key = publishKey();
  const bundle = makeBundle();
  const first = await h.publisher.submit(bundle, key, "lost-commit-response-0001");
  assert.equal(first.status, "preview_ready");
  assert.equal(writeCount(h, "/repository/commits"), 1);
  assert.equal(h.gitlab.state.projects.size, 1);
  await h.publisher.submit(bundle, key, "lost-commit-response-0001");
  assert.equal(writeCount(h, "/repository/commits"), 1);
  assert.equal(writeCount(h, "/repository/tags"), 1);
  assert.equal(writeCount(h, "/releases"), 1);
});

test("a conflicting version tag is never moved", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  const key = publishKey();
  const first = await h.publisher.submit(makeBundle(), key, "tag-seed-upload-000001");
  const appId = first.preview!.id;
  await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  const project = h.gitlab.state.projects.get(100)!;
  const conflictingSha = "f".repeat(40);
  h.gitlab.state.preseedTag(project.id, "v1.1.0", conflictingSha);
  const tagWritesBefore = writeCount(h, "/repository/tags");
  await assert.rejects(
    h.publisher.submit({ ...makeBundle("1.1.0", "新版本内容。"), managedAppId: first.managedAppId, expectedAppRevision: 1 }, key, "tag-conflict-update-0001"),
    error => { assertDomainError(error, "TAG_CONFLICT"); return true; },
  );
  assert.equal(project.tags.get("v1.1.0"), conflictingSha);
  assert.equal(writeCount(h, "/repository/tags"), tagWritesBefore);
  assert.equal(project.releases.has("v1.1.0"), false);
  assert.equal((await h.service.app(appId)).revision, 1);
});

test("an old expected revision is rejected before any GitLab write", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  const key = publishKey();
  const first = await h.publisher.submit(makeBundle(), key, "revision-seed-upload-0001");
  await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  const update = await h.publisher.submit({ ...makeBundle("1.1.0", "版本 1.1.0。"), managedAppId: first.managedAppId, expectedAppRevision: 1 }, key, "revision-update-good-0001");
  await h.service.confirm(update.id, update.ticket, { revision: update.revision, digest: update.digest! });
  const writesBefore = h.gitlab.state.writes.length;
  await assert.rejects(
    h.publisher.submit({ ...makeBundle("1.2.0", "过期 revision 不应写入。"), managedAppId: first.managedAppId, expectedAppRevision: 1 }, key, "revision-update-stale-0001"),
    error => { assertDomainError(error, "REVISION_CONFLICT"); return true; },
  );
  assert.equal(h.gitlab.state.writes.length, writesBefore);
});

test("large bundles recover a dropped middle chunk without duplicating the repo, tag, release, or commit", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  const extra = Array.from({ length: 205 }, (_, index) => ({ path: `src/module-${index}.ts`, text: `export const value${index} = ${index};` }));
  const key = publishKey();
  const bundle = makeBundle("1.0.0", undefined, extra);
  h.gitlab.state.dropCommitResponseOnNumber = 2;
  const result = await h.publisher.submit(bundle, key, "batched-upload-operation-0001");
  assert.equal(result.status, "preview_ready");
  assert.equal(writeCount(h, "/repository/commits"), 3);
  assert.equal(h.gitlab.state.projects.size, 1);
  const project = [...h.gitlab.state.projects.values()][0]!;
  assert.equal(project.branches.size, 1);
  const branchSha = [...project.branches.values()][0]!;
  assert.equal(project.commits.get(branchSha)?.files.size, 209);
  await h.publisher.submit(bundle, key, "batched-upload-operation-0001");
  assert.equal(writeCount(h, "/repository/commits"), 3);
  assert.equal(writeCount(h, "/repository/tags"), 1);
  assert.equal(writeCount(h, "/releases"), 1);
});

test("different publish keys create independent repositories even when appKey matches", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  await h.publisher.submit(makeBundle(), publishKey(), "same-app-key-upload-one-0001");
  await h.publisher.submit(makeBundle(), publishKey(), "same-app-key-upload-two-0001");
  assert.equal(h.gitlab.state.projects.size, 2);
  assert.equal(new Set([...h.gitlab.state.projects.values()].map(project => project.path)).size, 2);
});

test("catalog ownership follows the confirmed app when another pending candidate was recorded last", async t => {
  const h = await startManagedHarness();
  t.after(() => h.close());
  const key = publishKey();
  const first = await h.publisher.submit(makeBundle(), key, "candidate-a-managed-upload-01");
  const pendingB = await h.publisher.submit({
    ...makeBundle("1.0.1", "这是同一未确认应用的第二份候选。"),
    managedAppId: first.managedAppId,
    expectedAppRevision: 0,
  }, key, "candidate-b-independent-pending-01");
  assert.equal(pendingB.status, "preview_ready");
  assert.notEqual(pendingB.preview?.id, first.preview?.id);
  assert.equal(h.gitlab.state.projects.size, 1, "candidate B reuses the same managed repository");
  await h.db.query("UPDATE managed_app_bindings SET public_app_id = $1 WHERE id = $2", [pendingB.preview!.id, first.managedAppId]);

  const confirmedA = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  assert.equal(confirmedA.appId, first.preview!.id);
  assert.deepEqual(await h.publisher.findByAppId(confirmedA.appId!), {
    managedAppId: first.managedAppId,
    projectId: "100",
    appKey: "sample-1",
  });
  const staleB = await h.service.confirm(pendingB.id, pendingB.ticket, { revision: pendingB.revision, digest: pendingB.digest! });
  assert.equal(staleB.status, "failed");
  assert.equal(staleB.error?.code, "REVISION_CONFLICT", "the service's expected revision prevents pending B from replacing confirmed A");

  const update = await h.publisher.submit({
    ...makeBundle("1.1.0", "确认的候选 A 可以继续更新。"),
    managedAppId: first.managedAppId,
    expectedAppRevision: 1,
  }, key, "candidate-a-followup-update-01");
  assert.equal(update.status, "preview_ready");
  assert.equal(update.preview?.id, confirmedA.appId);
});
