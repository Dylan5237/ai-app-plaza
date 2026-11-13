import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.js";
import type { Config } from "../server/config.js";
import { openDatabase, type Database, type Queryable, type QueryResult } from "../server/domain/database.js";
import { manifest } from "./helpers/gitlab-fixture.js";
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from "./helpers/managed-gitlab-fixture.js";

const PLAZA_SECRET = "managed-validation-test-secret-with-at-least-32-bytes";
const TABLES = [
  "managed_app_bindings",
  "managed_publish_operations",
  "publications",
  "catalog_apps",
  "published_snapshots",
  "catalog_tag_overrides",
  "catalog_tag_cleanup_operations",
] as const;
const FETCH_FORBIDDEN_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6667, 6668, 6669, 6697, 10080,
]);

interface Diagnostic {
  code: string;
  ruleId: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  suggestion: string;
}

interface ApiResponse {
  status?: string;
  published?: boolean;
  sourceUploaded?: boolean;
  fileCount?: number;
  totalBytes?: number;
  managedAppId?: string;
  recoveryRequired?: boolean;
  nextAction?: string;
  operationStatus?: string;
  previewUrl?: string;
  id?: string;
  ticket?: string;
  error?: { code?: string; message?: string; diagnostics?: Diagnostic[] };
}

interface Portal {
  origin: string;
  app: Awaited<ReturnType<typeof createApp>>["app"];
  db: Database;
  gitlab: Awaited<ReturnType<typeof startManagedGitLabFixture>>;
  dbWrites: string[];
  failNextPublicationInsert(): void;
  close(): Promise<void>;
}

function trackedDatabase(db: Database, writes: string[], fault: { failNextPublicationInsert: boolean }): Database {
  const track = (queryable: Queryable): Queryable => ({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> => {
      if (/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/i.test(sql)) writes.push(sql.trim().replace(/\s+/g, " ").slice(0, 180));
      if (fault.failNextPublicationInsert && /^\s*INSERT\s+INTO\s+publications\b/i.test(sql)) {
        fault.failNextPublicationInsert = false;
        throw new Error("fixture publication insert interruption");
      }
      return queryable.query<Row>(sql, params);
    },
  });
  const root = track(db);
  return {
    query: root.query,
    transaction: <T>(work: (tx: Queryable) => Promise<T>) => db.transaction(tx => work(track(tx))),
    close: () => db.close(),
  };
}

async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    if (!FETCH_FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("could not allocate a loopback port allowed by Node fetch");
}

async function startPortal(analytics?: Config['analytics']): Promise<Portal> {
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const db = await openDatabase({ path: "memory://" });
  const dbWrites: string[] = [];
  const fault = { failNextPublicationInsert: false };
  const observedDb = trackedDatabase(db, dbWrites, fault);
  const gitlab = await startManagedGitLabFixture();
  const config: Config = {
    host: "127.0.0.1",
    port,
    publicOrigin: origin,
    gitlabUrl: gitlab.url,
    secret: PLAZA_SECRET,
    dataDir: "",
    local: true,
    audience: "所有能访问本门户的人",
    staticDir: resolve("dist"),
    rateLimit: false,
    managedPublishing: { groupId: "63", groupPath: "sky-efficiency-skills/ai-apps", token: MANAGED_GITLAB_TOKEN },
    analytics,
  };
  const { app } = await createApp(config, observedDb);
  await app.listen({ port, host: "127.0.0.1" });
  dbWrites.length = 0;
  return {
    origin,
    app,
    db,
    gitlab,
    dbWrites,
    failNextPublicationInsert: () => { fault.failNextPublicationInsert = true; },
    close: async () => { await app.close(); await db.close(); await gitlab.close(); },
  };
}

test('managed event journal records accepted operation and real stage transitions once', async t => {
  const portal = await startPortal({ environment:'test', siteInstanceId:'fixture' });
  t.after(() => portal.close());
  const headers = { 'x-plaza-publish-key':randomBytes(32).toString('base64url'), 'idempotency-key':randomUUID() };
  const result = await request(portal, 'POST', '/api/managed-publications', makeCandidate(), headers);
  assert.equal(result.status, 201, result.text);
  const repeat = await request(portal, 'POST', '/api/managed-publications', makeCandidate(), headers);
  assert.equal(repeat.status, 201, repeat.text);
  const row = (await portal.db.query<any>('SELECT analytics_journal FROM managed_publish_operations')).rows[0];
  const journal = row.analytics_journal;
  assert.equal(journal.filter((event:any) => event.eventName === 'publish_operation_received').length, 1);
  const start = journal.find((event:any) => event.eventName === 'publish_operation_received');
  assert.equal(journal.filter((event:any) => event.eventName === 'publish_attempt_finished' && event.attemptId === start.attemptId && event.result === 'success').length, 1);
  assert.deepEqual(journal.filter((event:any) => event.eventName === 'managed_publish_stage_changed').map((event:any) => event.toStage), ['prepared','project_ready','commit_ready','tag_ready','release_ready','submitted']);
  assert.ok(!JSON.stringify(journal).includes(MANAGED_GITLAB_TOKEN));
  assert.ok(!JSON.stringify(journal).includes(headers['x-plaza-publish-key']));
});

function makeCandidate(appKey = "sample-1"): Record<string, unknown> {
  const appManifest = {
    ...manifest(1),
    appKey,
    projectVersion: "1.0.0",
    docs: { readme: "README.md", usage: "docs/usage-1.md" },
  };
  const files = [
    { path: "ai-app.json", text: JSON.stringify(appManifest) },
    { path: "README.md", text: "# 文档助手\n\n受控后端协议测试。" },
    { path: "docs/usage-1.md", text: "# 使用说明\n\n整理并校验文档。" },
    { path: "docs/agent-1.md", text: "# Agent 接入说明\n\n只执行最小验证。" },
  ];
  return {
    appKey,
    manifestPath: "ai-app.json",
    files: files.map(({ path, text }) => ({ path, content: Buffer.from(text, "utf8").toString("base64") })),
  };
}

function replaceFile(candidate: Record<string, unknown>, oldPath: string, newPath: string, text: string): void {
  const files = candidate.files as Array<{ path: string; content: string }>;
  const index = files.findIndex(file => file.path === oldPath);
  if (index < 0) throw new Error("test candidate file is missing");
  files[index] = { path: newPath, content: Buffer.from(text, "utf8").toString("base64") };
}

async function tableSnapshot(db: Database): Promise<Record<string, { count: number; sha256: string }>> {
  const snapshot: Record<string, { count: number; sha256: string }> = {};
  for (const table of TABLES) {
    const rows = (await db.query<{ record: unknown }>(`SELECT to_jsonb(t) AS record FROM ${table} AS t`)).rows;
    const canonical = rows.map(row => JSON.stringify(row.record)).sort().join("\n");
    snapshot[table] = { count: rows.length, sha256: createHash("sha256").update(canonical).digest("hex") };
  }
  return snapshot;
}

async function request(portal: Portal, method: "POST" | "GET", route: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = `${portal.origin}${route}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown fetch error";
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
    const causeCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "unknown";
    const causeMessage = cause instanceof Error ? `; cause=${causeCode}:${cause.message}` : "";
    throw new Error(`${method} ${route} failed against loopback origin ${new URL(url).origin}: ${message}${causeMessage}`, { cause: error });
  }
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as ApiResponse };
}

function gitlabWriteCount(portal: Portal): number {
  return portal.gitlab.state.requests.filter(item => item.method !== "GET").length;
}

test("managed validation is repeatable, localized, redacted, and has no table or GitLab side effects", async t => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const before = await tableSnapshot(portal.db);
  const requestsBefore = portal.gitlab.state.requests.length;
  const writesBefore = gitlabWriteCount(portal);
  const valid = makeCandidate();
  const expectedBytes = (valid.files as Array<{ content: string }>).reduce((sum, file) => sum + Buffer.from(file.content, "base64").byteLength, 0);

  const first = await request(portal, "POST", "/api/managed-publications/validate", valid);
  const second = await request(portal, "POST", "/api/managed-publications/validate", valid);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, {
    status: "validated", published: false, sourceUploaded: false,
    fileCount: 4, totalBytes: expectedBytes,
  });
  assert.deepEqual(second.json, first.json);

  const suspicious = makeCandidate();
  const pathToken = `source-${"A".repeat(43)}.ts`;
  replaceFile(suspicious, "docs/usage-1.md", `src/${pathToken}`, "PRIVATE-TOKEN=SensitiveValueMustNeverEcho_123456");
  const invalid = await request(portal, "POST", "/api/managed-publications/validate", suspicious);
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.json.error?.code, "VALIDATION_FAILED");
  const diagnostic = invalid.json.error?.diagnostics?.[0];
  assert.equal(diagnostic?.code, "SECRET_MARKER_FOUND");
  assert.equal(diagnostic?.ruleId, "managed.bundle.secret_marker");
  assert.equal(diagnostic?.path, undefined, "token-like filename is omitted from the diagnostic");
  assert.equal(typeof diagnostic?.line, "number");
  assert.equal(typeof diagnostic?.column, "number");
  assert.ok(!invalid.text.includes(pathToken));
  assert.ok(!invalid.text.includes("SensitiveValueMustNeverEcho_123456"));
  assert.ok(!invalid.text.includes("PRIVATE-TOKEN="));

  const formal = await request(portal, "POST", "/api/managed-publications", suspicious, {
    "x-plaza-publish-key": randomBytes(32).toString("base64url"),
    "idempotency-key": randomUUID(),
  });
  assert.equal(formal.status, 400, formal.text);
  assert.deepEqual(formal.json.error?.diagnostics, invalid.json.error?.diagnostics, "formal upload uses the same package diagnostics");
  assert.deepEqual(await tableSnapshot(portal.db), before);
  assert.deepEqual(portal.dbWrites, [], "neither precheck nor invalid formal upload writes any of the seven business tables");
  assert.equal(portal.gitlab.state.requests.length, requestsBefore, "precheck makes no GitLab request");
  assert.equal(gitlabWriteCount(portal), writesBefore);
});

test("managed validation uses safe compatible request and manifest field locators", async t => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const before = await tableSnapshot(portal.db);
  const privateProperty = 'PRIVATE_PROPERTY_SENTINEL';
  const privateValue = 'PRIVATE_VALUE_SENTINEL';
  for (const [file, field] of [
    [{ path: 42, content: '' }, 'files[0].path'],
    [{ path: 'README.md', content: { [privateProperty]: privateValue } }, 'files[0].content'],
    [{ path: 'README.md', content: '', [privateProperty]: privateValue }, 'files[0]'],
  ] as const) {
    const result = await request(portal, 'POST', '/api/managed-publications/validate', {
      ...makeCandidate(), files: [file],
    });
    assert.equal(result.status, 400);
    assert.equal(result.json.error?.code, 'INVALID_REQUEST');
    assert.equal(result.json.error?.diagnostics?.[0]?.field, field);
    assert.ok(!result.text.includes(privateProperty) && !result.text.includes(privateValue));
  }
  const unknownRequest = await request(portal, 'POST', '/api/managed-publications/validate', {
    ...makeCandidate(), [privateProperty]: privateValue,
  });
  assert.equal(unknownRequest.json.error?.diagnostics?.[0]?.field, 'request');
  assert.ok(!unknownRequest.text.includes(privateProperty) && !unknownRequest.text.includes(privateValue));

  for (const [patch, field] of [
    [{ maintainers: [] }, 'maintainers'],
    [{ name: { [privateProperty]: privateValue } }, 'name'],
    [{ examples: [{ request: '测试', expectedResult: 42 }] }, 'examples[0].expectedResult'],
    [{ examples: [{ request: '测试', expectedResult: '完成', [privateProperty]: privateValue }] }, 'examples[0]'],
  ] as const) {
    const candidate = makeCandidate();
    const files = candidate.files as Array<{ path: string; content: string }>;
    const source = JSON.parse(Buffer.from(files[0]!.content, 'base64').toString('utf8'));
    replaceFile(candidate, 'ai-app.json', 'ai-app.json', JSON.stringify({ ...source, ...patch }));
    const result = await request(portal, 'POST', '/api/managed-publications/validate', candidate);
    assert.equal(result.status, 400);
    assert.equal(result.json.error?.diagnostics?.[0]?.code, 'MANIFEST_SCHEMA_INVALID');
    assert.equal(result.json.error?.diagnostics?.[0]?.path, 'ai-app.json');
    assert.equal(result.json.error?.diagnostics?.[0]?.field, field);
    assert.ok(!result.text.includes(privateProperty) && !result.text.includes(privateValue));
  }
  assert.deepEqual(await tableSnapshot(portal.db), before);
  assert.deepEqual(portal.dbWrites, []);
  assert.equal(portal.gitlab.state.requests.length, 0);
});

test("receipt returns the original preview for its owner and rejects another key or mismatched publication hash", async t => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const publishKey = randomBytes(32).toString("base64url");
  const idempotencyKey = randomUUID();
  const submitted = await request(portal, "POST", "/api/managed-publications", makeCandidate(), {
    "x-plaza-publish-key": publishKey,
    "idempotency-key": idempotencyKey,
  });
  assert.equal(submitted.status, 201, submitted.text);
  assert.equal(submitted.json.status, "preview_ready");
  const receiptHeaders = { "x-plaza-publish-key": publishKey, "idempotency-key": idempotencyKey };
  const beforeReceipt = await tableSnapshot(portal.db);
  const dbWriteStart = portal.dbWrites.length;
  const gitlabRequestStart = portal.gitlab.state.requests.length;
  const gitlabWritesStart = gitlabWriteCount(portal);

  const receipt = await request(portal, "GET", "/api/managed-publications/receipt", undefined, receiptHeaders);
  assert.equal(receipt.status, 200, receipt.text);
  assert.equal(receipt.json.id, submitted.json.id);
  assert.equal(receipt.json.previewUrl, submitted.json.previewUrl);
  assert.equal(receipt.json.ticket, submitted.json.ticket);
  assert.equal(receipt.json.managedAppId, submitted.json.managedAppId);
  assert.equal(receipt.json.sourceUploaded, true);
  assert.deepEqual(await tableSnapshot(portal.db), beforeReceipt);
  assert.equal(portal.dbWrites.length, dbWriteStart, "receipt lookup performs no database write");
  assert.equal(gitlabWriteCount(portal), gitlabWritesStart, "receipt lookup performs no GitLab write");
  assert.deepEqual(portal.gitlab.state.requests.slice(gitlabRequestStart).map(item => item.path), ["/api/v4/user"]);

  const wrongOwner = await request(portal, "GET", "/api/managed-publications/receipt", undefined, {
    "x-plaza-publish-key": randomBytes(32).toString("base64url"), "idempotency-key": idempotencyKey,
  });
  assert.equal(wrongOwner.status, 404);
  assert.equal(wrongOwner.json.error?.code, "MANAGED_OPERATION_NOT_FOUND");

  const operation = (await portal.db.query<{ id: string }>("SELECT id FROM managed_publish_operations LIMIT 1")).rows[0]!;
  await portal.db.query("UPDATE managed_publish_operations SET commit_sha = $2 WHERE id = $1", [operation.id, "b".repeat(40)]);
  const beforeMismatch = await tableSnapshot(portal.db);
  const mismatchWrites = portal.dbWrites.length;
  const mismatch = await request(portal, "GET", "/api/managed-publications/receipt", undefined, receiptHeaders);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.error?.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await tableSnapshot(portal.db), beforeMismatch);
  assert.equal(portal.dbWrites.length, mismatchWrites, "same idempotency identity with a different request hash is refused read-only");
});

test("receipt reports partial operations and rejects expired publications without cleanup or advancing state", async t => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const owner = randomBytes(32).toString("base64url");
  const pendingKey = randomUUID();
  portal.gitlab.state.rejectNextProjectStatus = 503;
  const pending = await request(portal, "POST", "/api/managed-publications", makeCandidate(), {
    "x-plaza-publish-key": owner,
    "idempotency-key": pendingKey,
  });
  assert.equal(pending.status, 503);
  const partialBefore = await tableSnapshot(portal.db);
  const partialWrites = portal.dbWrites.length;
  const partialGitLabWrites = gitlabWriteCount(portal);
  const partial = await request(portal, "GET", "/api/managed-publications/receipt", undefined, {
    "x-plaza-publish-key": owner,
    "idempotency-key": pendingKey,
  });
  assert.equal(partial.status, 200, partial.text);
  assert.equal(partial.json.status, "recovery_required");
  assert.equal(partial.json.nextAction, "retry_original");
  assert.equal(partial.json.recoveryRequired, true);
  assert.equal(partial.json.sourceUploaded, false);
  assert.equal(partial.json.operationStatus, "prepared");
  assert.deepEqual(await tableSnapshot(portal.db), partialBefore);
  assert.equal(portal.dbWrites.length, partialWrites);
  assert.equal(gitlabWriteCount(portal), partialGitLabWrites);

  const completeKey = randomUUID();
  const completeOwner = randomBytes(32).toString("base64url");
  const complete = await request(portal, "POST", "/api/managed-publications", makeCandidate("sample-expired"), {
    "x-plaza-publish-key": completeOwner,
    "idempotency-key": completeKey,
  });
  assert.equal(complete.status, 201, complete.text);
  const publicationId = complete.json.id!;
  await portal.db.query("UPDATE publications SET expires_at = $2 WHERE id = $1", [publicationId, new Date(Date.now() - 60_000)]);
  const expiredBefore = await tableSnapshot(portal.db);
  const tokenBefore = (await portal.db.query<{ token_ciphertext: string | null }>("SELECT token_ciphertext FROM publications WHERE id = $1", [publicationId])).rows[0]?.token_ciphertext;
  const expiredWrites = portal.dbWrites.length;
  const expired = await request(portal, "GET", "/api/managed-publications/receipt", undefined, {
    "x-plaza-publish-key": completeOwner,
    "idempotency-key": completeKey,
  });
  assert.equal(expired.status, 410, expired.text);
  assert.equal(expired.json.error?.code, "PUBLICATION_EXPIRED");
  assert.equal(portal.dbWrites.length, expiredWrites);
  assert.equal(tokenBefore, (await portal.db.query<{ token_ciphertext: string | null }>("SELECT token_ciphertext FROM publications WHERE id = $1", [publicationId])).rows[0]?.token_ciphertext);
  assert.deepEqual(await tableSnapshot(portal.db), expiredBefore);
});

test("receipt does not mark an intermediate multi-batch commit checkpoint as uploaded source", async t => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const owner = randomBytes(32).toString("base64url");
  const idempotencyKey = randomUUID();
  const candidate = makeCandidate("sample-multi-batch-partial");
  const files = candidate.files as Array<{ path: string; content: string }>;
  for (let index = 0; index < 101; index++) {
    files.push({
      path: `generated/part-${String(index).padStart(3, "0")}.txt`,
      content: Buffer.from(`bounded upload fixture part ${index}\n`, "utf8").toString("base64"),
    });
  }
  portal.gitlab.state.rejectCommitStatusOnNumber = 2;

  const stopped = await request(portal, "POST", "/api/managed-publications", candidate, {
    "x-plaza-publish-key": owner,
    "idempotency-key": idempotencyKey,
  });
  assert.equal(stopped.status, 503, stopped.text);
  assert.equal(stopped.json.error?.code, "SOURCE_UNAVAILABLE");
  assert.equal(portal.gitlab.state.commitCreateCount, 2, "the second batch is rejected after the first was confirmed");

  const binding = (await portal.db.query<{ id: string }>(
    "SELECT id FROM managed_app_bindings LIMIT 1",
  )).rows[0]!;
  const operation = (await portal.db.query<{
    id: string; project_id: string | null; commit_sha: string | null; status: string;
  }>(
    "SELECT id, project_id, commit_sha, status FROM managed_publish_operations LIMIT 1",
  )).rows[0]!;
  assert.equal(operation.status, "project_ready", "the operation has not crossed the complete-upload checkpoint");
  assert.ok(operation.project_id);
  assert.ok(operation.commit_sha, "the confirmed first-batch SHA remains a recovery checkpoint");
  const project = portal.gitlab.state.projects.get(Number(operation.project_id))!;
  const checkpoint = project.commits.get(operation.commit_sha)!;
  assert.match(checkpoint.message, /Batch: 1\/2(?:\n|$)/);
  assert.equal(checkpoint.files.size, 100, "the checkpoint contains only the first 100 of 105 source files");

  const beforeReceipt = await tableSnapshot(portal.db);
  const writesBefore = portal.dbWrites.length;
  const gitlabWritesBefore = gitlabWriteCount(portal);
  const receipt = await request(portal, "GET", "/api/managed-publications/receipt", undefined, {
    "x-plaza-publish-key": owner,
    "idempotency-key": idempotencyKey,
  });
  assert.equal(receipt.status, 200, receipt.text);
  assert.equal(receipt.json.status, "recovery_required");
  assert.equal(receipt.json.nextAction, "retry_original");
  assert.equal(receipt.json.recoveryRequired, true);
  assert.equal(receipt.json.sourceUploaded, false, "an intermediate batch SHA is not proof that all source is uploaded");
  assert.equal(receipt.json.operationStatus, "project_ready");
  assert.deepEqual(await tableSnapshot(portal.db), beforeReceipt, "receipt lookup leaves all seven business tables unchanged");
  assert.equal(portal.dbWrites.length, writesBefore, "receipt lookup performs no SQL writes");
  assert.equal(gitlabWriteCount(portal), gitlabWritesBefore, "receipt lookup performs no GitLab writes");
  assert.equal(portal.gitlab.state.writes.length, gitlabWritesBefore);
  assert.equal(binding.id, receipt.json.managedAppId);
});

test("receipt marks source uploaded when its publication insert was interrupted after release_ready", async t => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const owner = randomBytes(32).toString("base64url");
  const idempotencyKey = randomUUID();
  portal.failNextPublicationInsert();
  const failed = await request(portal, "POST", "/api/managed-publications", makeCandidate("sample-no-publication"), {
    "x-plaza-publish-key": owner,
    "idempotency-key": idempotencyKey,
  });
  assert.equal(failed.status, 503, failed.text);
  assert.equal(failed.json.error?.code, "PUBLICATION_FAILED");

  const binding = (await portal.db.query<{ id: string; publish_key_digest: string }>(
    "SELECT id, publish_key_digest FROM managed_app_bindings LIMIT 1",
  )).rows[0]!;
  const operation = (await portal.db.query<{
    id: string; idempotency_digest: string; request_digest: string; status: string;
    project_id: string | null; commit_sha: string | null; tag: string;
  }>("SELECT id, idempotency_digest, request_digest, status, project_id, commit_sha, tag FROM managed_publish_operations LIMIT 1")).rows[0]!;
  assert.equal(operation.status, "release_ready");
  assert.ok(operation.project_id);
  assert.ok(operation.commit_sha);
  assert.equal((await portal.db.query("SELECT id FROM publications")).rows.length, 0);
  const project = portal.gitlab.state.projects.get(Number(operation.project_id))!;
  assert.ok(project.commits.has(operation.commit_sha));
  assert.equal(project.tags.get(operation.tag), operation.commit_sha);
  assert.equal(project.releases.get(operation.tag), operation.commit_sha);

  const beforeReceipt = await tableSnapshot(portal.db);
  const identityBefore = {
    bindingId: binding.id,
    publishKeyDigest: binding.publish_key_digest,
    operationId: operation.id,
    idempotencyDigest: operation.idempotency_digest,
    requestDigest: operation.request_digest,
  };
  const writesBefore = portal.dbWrites.length;
  const gitlabRequestsBefore = portal.gitlab.state.requests.length;
  const gitlabWritesBefore = gitlabWriteCount(portal);
  const receipt = await request(portal, "GET", "/api/managed-publications/receipt", undefined, {
    "x-plaza-publish-key": owner,
    "idempotency-key": idempotencyKey,
  });
  assert.equal(receipt.status, 200, receipt.text);
  assert.equal(receipt.json.status, "recovery_required");
  assert.equal(receipt.json.nextAction, "retry_original");
  assert.equal(receipt.json.recoveryRequired, true);
  assert.equal(receipt.json.managedAppId, binding.id);
  assert.equal(receipt.json.sourceUploaded, true);
  assert.equal(receipt.json.operationStatus, "release_ready");
  assert.equal(Object.hasOwn(receipt.json, "previewUrl"), false);
  assert.equal(Object.hasOwn(receipt.json, "ticket"), false);
  assert.deepEqual(await tableSnapshot(portal.db), beforeReceipt);
  assert.equal(portal.dbWrites.length, writesBefore, "receipt lookup performs no SQL writes");
  assert.equal(gitlabWriteCount(portal), gitlabWritesBefore, "receipt lookup performs no GitLab writes");
  assert.deepEqual(portal.gitlab.state.requests.slice(gitlabRequestsBefore).map(item => item.path), ["/api/v4/user"]);
  const unchangedOperation = (await portal.db.query<{
    id: string; idempotency_digest: string; request_digest: string;
    status: string; project_id: string | null; commit_sha: string | null;
  }>(
    "SELECT id, idempotency_digest, request_digest, status, project_id, commit_sha FROM managed_publish_operations LIMIT 1",
  )).rows[0]!;
  assert.deepEqual(unchangedOperation, {
    id: operation.id,
    idempotency_digest: operation.idempotency_digest,
    request_digest: operation.request_digest,
    status: "release_ready",
    project_id: operation.project_id,
    commit_sha: operation.commit_sha,
  });
  const unchangedBinding = (await portal.db.query<{ id: string; publish_key_digest: string }>(
    "SELECT id, publish_key_digest FROM managed_app_bindings LIMIT 1",
  )).rows[0]!;
  assert.deepEqual({
    bindingId: unchangedBinding.id,
    publishKeyDigest: unchangedBinding.publish_key_digest,
    operationId: unchangedOperation.id,
    idempotencyDigest: unchangedOperation.idempotency_digest,
    requestDigest: unchangedOperation.request_digest,
  }, identityBefore, "receipt keeps the original owner/idempotency identity");
});
