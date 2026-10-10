import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDatabase } from "../server/domain/database.js";
import { DomainError } from "../server/domain/errors.js";
import { createService } from "../server/domain/service.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const GITLAB_TOKEN = "test-author-gitlab-token-never-return-this";

interface GitLabFixture {
  url: string;
  rawReads: string[];
  pathsRead: string[];
  userReads: number;
  role: { project_access: number; group_access: number };
  failRaw: boolean;
  setVersion(commit: string, manifest: Record<string, unknown>, docs?: Record<string, string>): void;
  setManifestText(commit: string, text: string): void;
  close(): Promise<void>;
}

async function setup(t: { after(callback: () => void | Promise<void>): void }) {
  const fixture = await startGitLabFixture();
  const db = await openDatabase({ path: "memory://" });
  const service = createService({
    db,
    gitlabUrl: fixture.url,
    publicOrigin: "http://127.0.0.1:3000",
    secret: "test-secret-with-at-least-thirty-two-bytes",
    audience: "company-internal",
  });
  t.after(async () => {
    await db.close();
    await fixture.close();
  });
  return { fixture, db, service };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    appKey: "project-flow",
    name: "自动化方案",
    summary: "自动化生成项目工作流与成果",
    tags: ["流程", "数据"],
    maintainers: ["author@example.invalid"],
    capabilities: {
      scenarios: ["企业任务需求梳理"],
      inputs: ["业务目标"],
      outputs: ["可执行工作流"],
    },
    examples: [{ request: "梳理项目流程", expectedResult: "生成工作流" }],
    requirements: [],
    limitations: ["需要人工复核"],
    docs: { readme: "docs/guide.md", usage: "docs/guide.md" },
    entries: [{
      id: "agent-main",
      kind: "agent",
      label: "项目 Agent",
      instructionsPath: "docs/instructions.md",
      compatibility: ["Codex", "WorkBuddy"],
      artifacts: [{ url: "https://example.invalid/package.zip", sha256: "0".repeat(64) }],
    }],
    primaryEntry: "agent-main",
    ...overrides,
  };
}

function sourceInput(commitSha = COMMIT_A, extra: Record<string, unknown> = {}) {
  return {
    projectId: 1,
    appKey: "project-flow",
    manifestPath: "ai-app.json",
    commitSha,
    ...extra,
  };
}

async function startGitLabFixture(): Promise<GitLabFixture> {
  const versions = new Map<string, Map<string, Buffer>>();
  const rawReads: string[] = [];
  const pathsRead: string[] = [];
  let userReads = 0;
  let role = { project_access: 30, group_access: 40 };
  let failRaw = false;
  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const requestPath = requestUrl.pathname;
    pathsRead.push(requestPath);
    if (request.headers["private-token"] !== GITLAB_TOKEN) {
      return sendJson(response, 401, { message: "unauthorized" });
    }
    if (requestPath === "/api/v4/user") {
      userReads++;
      return sendJson(response, 200, { id: 42 });
    }
    if (requestPath === "/api/v4/projects/1") {
      return sendJson(response, 200, {
        id: 1,
        created_at: "2025-03-01T12:00:00.000Z",
        web_url: `${fixtureUrl(server)}/team/project-flow`,
        permissions: { project_access: { access_level: role.project_access }, group_access: { access_level: role.group_access } },
      });
    }
    const commitMatch = /^\/api\/v4\/projects\/1\/repository\/commits\/([a-f0-9]+)$/.exec(requestPath);
    if (commitMatch) {
      const commit = commitMatch[1]!;
      if (!versions.has(commit)) return sendJson(response, 404, { message: "not found" });
      return sendJson(response, 200, { id: commit });
    }
    const tagMatch = /^\/api\/v4\/projects\/1\/repository\/tags\/(.+)$/.exec(requestPath);
    if (tagMatch) return sendJson(response, 200, { commit: { id: decodeURIComponent(tagMatch[1]!) === "v1" ? COMMIT_A : COMMIT_B } });

    if (requestPath === "/api/v4/projects/1/repository/tree") {
      const commit = requestUrl.searchParams.get("ref") ?? "";
      if (!versions.has(commit)) return sendJson(response, 404, { message: "not found" });
      const treePath = requestUrl.searchParams.get("path") ?? "";
      const paths = [...versions.get(commit)!.keys()];
      if (treePath === "") {
        return sendJson(response, 200, [
          { name: "ai-app.json", type: "blob", mode: "100644" },
          { name: "docs", type: "tree", mode: "040000" },
        ]);
      }
      const files = paths.filter((value) => value.startsWith(`${treePath}/`)).map((value) => value.slice(treePath.length + 1));
      const directNames = [...new Set(files.map((value) => value.split("/")[0]!))];
      return sendJson(response, 200, directNames.map((name) => {
        const isDirectory = files.some((value) => value.startsWith(`${name}/`));
        return { name, type: isDirectory ? "tree" : "blob", mode: isDirectory ? "040000" : "100644" };
      }));
    }

    const fileMatch = /^\/api\/v4\/projects\/1\/repository\/files\/(.+)\/raw$/.exec(requestPath);
    if (fileMatch) {
      if (failRaw) return sendJson(response, 503, { message: "temporarily unavailable" });
      const filePath = decodeURIComponent(fileMatch[1]!);
      const commit = requestUrl.searchParams.get("ref") ?? "";
      rawReads.push(filePath);
      const bytes = versions.get(commit)?.get(filePath);
      if (!bytes) return sendJson(response, 404, { message: "not found" });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(bytes);
      return;
    }
    return sendJson(response, 404, { message: "not found" });
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a port.");
  const url = `http://127.0.0.1:${address.port}/`;
  const fixture: GitLabFixture = {
    url,
    rawReads,
    pathsRead,
    get userReads() { return userReads; },
    get role() { return role; },
    set role(value) { role = value; },
    get failRaw() { return failRaw; },
    set failRaw(value) { failRaw = value; },
    setVersion(commit, appManifest, docs = {}) {
      const files = new Map<string, Buffer>([
        ["ai-app.json", Buffer.from(JSON.stringify(appManifest), "utf8")],
        ["docs/guide.md", Buffer.from(docs["docs/guide.md"] ?? "# 使用说明\n执行项目流程。", "utf8")],
        ["docs/instructions.md", Buffer.from(docs["docs/instructions.md"] ?? "# Agent 接入\n按步骤运行。", "utf8")],
      ]);
      versions.set(commit, files);
    },
    setManifestText(commit, text) {
      const files = versions.get(commit) ?? new Map<string, Buffer>();
      files.set("ai-app.json", Buffer.from(text, "utf8"));
      if (!files.has("docs/guide.md")) files.set("docs/guide.md", Buffer.from("# 使用说明\n执行项目流程。", "utf8"));
      if (!files.has("docs/instructions.md")) files.set("docs/instructions.md", Buffer.from("# Agent 接入\n按步骤运行。", "utf8"));
      versions.set(commit, files);
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
  fixture.setVersion(COMMIT_A, manifest());
  return fixture;
}

function fixtureUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server is not listening.");
  return `http://127.0.0.1:${address.port}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("publishes fixed GitLab source with a capability ticket, then serves only the approved snapshot", async (t) => {
  const { fixture, service } = await setup(t);
  const result = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0001");

  assert.equal(result.status, "preview_ready");
  assert.equal(result.preview?.revision, 1);
  assert.match(result.previewUrl, /#publish=[0-9a-f-]+&key=[A-Za-z0-9_-]+$/);
  assert.equal(JSON.stringify(result).includes(GITLAB_TOKEN), false);
  assert.deepEqual(new Set(fixture.rawReads), new Set(["ai-app.json", "docs/guide.md", "docs/instructions.md"]));

  await assert.rejects(service.publication(result.id, "not-a-ticket"), (error: unknown) =>
    error instanceof DomainError && error.statusCode === 404,
  );
  await assert.rejects(
    service.confirm(result.id, result.ticket, { revision: result.revision, digest: "0".repeat(64) }),
    (error: unknown) => error instanceof DomainError && error.code === "SOURCE_MISMATCH",
  );
  const registered = await service.confirm(result.id, result.ticket, { revision: result.revision, digest: result.digest! });
  assert.equal(registered.status, "registered");
  assert.equal(registered.appId, result.preview?.id);

  const userReadsAfterConfirm = fixture.userReads;
  const repeated = await service.confirm(result.id, result.ticket, { revision: result.revision, digest: result.digest! });
  assert.equal(repeated.status, "registered");
  assert.equal(fixture.userReads, userReadsAfterConfirm, "registered repeats should not require the cleared GitLab token");

  const list = await service.list({ query: "自动化工作流", tags: ["流程"], page: 1 });
  assert.equal(list.total, 1);
  assert.deepEqual(list.items[0]?.documents, {});
  assert.deepEqual(list.tags, ["数据", "流程"]);
  const detail = await service.app(registered.appId!);
  assert.equal(detail.documents["docs/guide.md"], "# 使用说明\n执行项目流程。");
  const instructions = await service.instructions(detail.id, "agent-main");
  assert.ok(instructions.text.includes(detail.source.projectUrl));
  assert.match(instructions.text, new RegExp(detail.source.commitSha));
  assert.match(instructions.text, /docs\/instructions\.md/);
  assert.match(instructions.text, /SHA-256/);
  assert.match(instructions.text, /不代表应用已下载、安装或运行成功/);
  assert.ok(instructions.text.endsWith("# Agent 接入\n按步骤运行。"));
  assert.deepEqual(instructions.compatibility, ["Codex", "WorkBuddy"]);
  assert.equal(JSON.stringify({ detail, instructions }).includes(GITLAB_TOKEN), false);
});

test("uses group access, idempotency, and content deduplication without creating duplicate catalog apps", async (t) => {
  const { fixture, service } = await setup(t);
  fixture.role = { project_access: 10, group_access: 40 };
  const first = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0002");
  const repeated = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0002");
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.ticket, first.ticket);

  await assert.rejects(
    service.submit(sourceInput(COMMIT_A, { expectedAppRevision: 3 }), GITLAB_TOKEN, "publish-0002"),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );

  const firstRegistered = await service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  const newKeySameContent = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0003");
  assert.equal(newKeySameContent.status, "registered");
  assert.equal(newKeySameContent.appId, firstRegistered.appId);
  assert.equal(newKeySameContent.preview?.revision, 1);
  assert.equal((await service.list()).total, 1);
});

test("concurrent confirmations for identical first publication create one app and one revision", async (t) => {
  const { service } = await setup(t);
  const first = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0011");
  const second = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0012");
  assert.equal(first.status, "preview_ready");
  assert.equal(second.status, "preview_ready");

  const results = await Promise.all([
    service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! }),
    service.confirm(second.id, second.ticket, { revision: second.revision, digest: second.digest! }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["registered", "registered"]);
  assert.equal(results[0]?.appId, results[1]?.appId);
  assert.equal((await service.list()).total, 1);
  assert.equal((await service.app(results[0]!.appId!)).revision, 1);
});

test("fails closed on insufficient effective GitLab role and rejects repeated JSON keys", async (t) => {
  const { fixture, service } = await setup(t);
  fixture.role = { project_access: 39, group_access: 20 };
  const denied = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0004");
  assert.equal(denied.status, "failed");
  assert.equal(denied.error?.code, "PERMISSION_DENIED");

  const duplicate = '{"schemaVersion":"1","schemaVersion":"1"}';
  fixture.setVersion(COMMIT_B, manifest());
  fixture.setManifestText(COMMIT_B, duplicate);
  fixture.role = { project_access: 40, group_access: 0 };
  const invalid = await service.submit(sourceInput(COMMIT_B), GITLAB_TOKEN, "publish-0005");
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.error?.code, "VALIDATION_FAILED");
});

test("source outages are recorded and retry resumes the confirmed registration", async (t) => {
  const { fixture, service } = await setup(t);
  const preview = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0006");
  assert.equal(preview.status, "preview_ready");
  fixture.failRaw = true;
  const failed = await service.confirm(preview.id, preview.ticket, { revision: preview.revision, digest: preview.digest! });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "SOURCE_UNAVAILABLE");
  assert.equal(failed.nextAction, "retry");

  fixture.failRaw = false;
  const retried = await service.retry(preview.id, preview.ticket);
  assert.equal(retried.status, "registered");
  assert.equal((await service.list()).total, 1);
});

test("confirmation cannot overwrite a newer app revision", async (t) => {
  const { fixture, service } = await setup(t);
  const initial = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0007");
  await service.confirm(initial.id, initial.ticket, { revision: initial.revision, digest: initial.digest! });

  fixture.setVersion(COMMIT_B, manifest({ name: "自动化方案 B" }));
  fixture.setVersion(COMMIT_C, manifest({ name: "自动化方案 C" }));
  const candidateB = await service.submit(sourceInput(COMMIT_B, { expectedAppRevision: 1 }), GITLAB_TOKEN, "publish-0008");
  const candidateC = await service.submit(sourceInput(COMMIT_C, { expectedAppRevision: 1 }), GITLAB_TOKEN, "publish-0009");
  assert.equal(candidateB.status, "preview_ready");
  assert.equal(candidateC.status, "preview_ready");

  const publishedB = await service.confirm(candidateB.id, candidateB.ticket, { revision: candidateB.revision, digest: candidateB.digest! });
  assert.equal(publishedB.status, "registered");
  const staleC = await service.confirm(candidateC.id, candidateC.ticket, { revision: candidateC.revision, digest: candidateC.digest! });
  assert.equal(staleC.status, "failed");
  assert.equal(staleC.error?.code, "REVISION_CONFLICT");
  const current = await service.app(publishedB.appId!);
  assert.equal(current.revision, 2);
  assert.equal(current.manifest.name, "自动化方案 B");
});

test("confirmation detects a changed preview source and requires a new candidate", async (t) => {
  const { fixture, service } = await setup(t);
  const preview = await service.submit(sourceInput(), GITLAB_TOKEN, "publish-0010");
  fixture.setVersion(COMMIT_A, manifest(), { "docs/guide.md": "# 已变化的说明\n新内容。" });
  const failed = await service.confirm(preview.id, preview.ticket, { revision: preview.revision, digest: preview.digest! });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "SOURCE_MISMATCH");
  assert.equal(failed.nextAction, "submit_again");
  await assert.rejects(service.retry(preview.id, preview.ticket), (error: unknown) =>
    error instanceof DomainError && error.code === "SOURCE_MISMATCH",
  );
  assert.equal((await service.list()).total, 0);
});

test("PGlite requires an explicit mode and persistent paths survive reopening", async (t) => {
  await assert.rejects(openDatabase({}), /Exactly one of DATABASE_URL or PGlite path/);
  const base = await mkdtemp(path.join(os.tmpdir(), "ai-app-plaza-domain-"));
  const dbPath = path.join(base, "catalog");
  t.after(async () => {
    const resolvedBase = path.resolve(base);
    assert.equal(resolvedBase.startsWith(path.resolve(os.tmpdir())), true);
    await rm(resolvedBase, { recursive: true, force: true });
  });
  const db = await openDatabase({ path: dbPath });
  await db.query("INSERT INTO catalog_apps (id, instance_id, project_id, app_key, revision, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, now(), now())", ["00000000-0000-4000-8000-000000000001", "gitlab", "1", "persistent"]);
  await db.close();
  const reopened = await openDatabase({ path: dbPath });
  const result = await reopened.query<{ app_key: string }>("SELECT app_key FROM catalog_apps WHERE project_id = $1", ["1"]);
  assert.equal(result.rows[0]?.app_key, "persistent");
  await reopened.close();
});
