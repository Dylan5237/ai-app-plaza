import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "../server/app.js";
import type { Config } from "../server/config.js";
import { openDatabase } from "../server/domain/database.js";
import { manifest } from "./helpers/gitlab-fixture.js";
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from "./helpers/managed-gitlab-fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const PLAZA_SECRET = "managed-http-test-secret-with-at-least-32-bytes";
const APP_KEY = "sample-1";

interface CapturedSubmission {
  ownerKey: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  headersJson: string;
}

interface ManagedPortal {
  origin: string;
  app: Awaited<ReturnType<typeof createApp>>["app"];
  db: Awaited<ReturnType<typeof openDatabase>>;
  gitlab: Awaited<ReturnType<typeof startManagedGitLabFixture>>;
  submissions: CapturedSubmission[];
  statusKeys: string[];
  close(): Promise<void>;
}

async function allocatePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startManagedPortal(): Promise<ManagedPortal> {
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const db = await openDatabase({ path: "memory://" });
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
    staticDir: path.join(REPO_ROOT, "dist"),
    rateLimit: false,
    managedPublishing: {
      groupId: "63",
      groupPath: "sky-efficiency-skills/ai-apps",
      token: MANAGED_GITLAB_TOKEN,
    },
  };
  const { app } = await createApp(config, db);
  const submissions: CapturedSubmission[] = [];
  const statusKeys: string[] = [];
  app.addHook("preHandler", async (request) => {
    const pathOnly = request.url.split("?", 1)[0];
    if (request.method === "POST" && pathOnly === "/api/managed-publications") {
      const body = JSON.parse(JSON.stringify(request.body ?? {})) as Record<string, unknown>;
      submissions.push({
        ownerKey: String(request.headers["x-plaza-publish-key"] ?? ""),
        idempotencyKey: String(request.headers["idempotency-key"] ?? ""),
        body,
        headersJson: JSON.stringify(request.headers),
      });
    } else if (request.method === "GET" && /^\/api\/managed-apps\/[^/]+\/status$/.test(pathOnly)) {
      statusKeys.push(String(request.headers["x-plaza-publish-key"] ?? ""));
    }
  });
  await app.listen({ port, host: "127.0.0.1" });
  return {
    origin,
    app,
    db,
    gitlab,
    submissions,
    statusKeys,
    close: async () => {
      await app.close();
      await db.close();
      await gitlab.close();
    },
  };
}

async function makeProject(parent: string): Promise<string> {
  const root = path.join(parent, "local-app");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeVersion(root, "1.0.0", "整理文档并生成可核对的 Markdown 输出。", 'export const release = "one";\n');
  return root;
}

async function writeVersion(root: string, version: string, summary: string, source: string): Promise<void> {
  const appManifest = { ...manifest(1), appKey: APP_KEY, projectVersion: version, summary };
  await writeFile(path.join(root, "ai-app.json"), JSON.stringify(appManifest, null, 2));
  await writeFile(path.join(root, "docs", "usage-1.md"), `# 使用说明\n\n${summary}\n`);
  await writeFile(path.join(root, "docs", "agent-1.md"), "# Agent 接入说明\n\n核对环境后执行最小验证。\n");
  await writeFile(path.join(root, "src", "main.ts"), source);
}

function runCli(scriptPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-u", scriptPath, ...args], {
      env: { ...process.env, PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function cliJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("publisher CLI did not return a JSON result");
  }
}

function previewCapabilities(value: unknown, origin: string): { publicationId: string; ticket: string } {
  assert.equal(typeof value, "string", "the CLI returns an author preview URL");
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new Error("the CLI preview URL is invalid");
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const keys = [...params.keys()].sort();
  const publicationId = params.get("publish") ?? "";
  const ticket = params.get("key") ?? "";
  assert.ok(
    url.origin === origin && url.pathname === "/" && url.search === "" &&
      keys.length === 2 && keys[0] === "key" && keys[1] === "publish" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicationId) &&
      /^[A-Za-z0-9_-]{43}$/.test(ticket),
    "preview URL contains only the same-origin publish UUID and ticket fragment",
  );
  return { publicationId, ticket };
}

async function confirmPreview(origin: string, previewUrl: unknown): Promise<{ appId: string; publicationId: string }> {
  const { publicationId, ticket } = previewCapabilities(previewUrl, origin);
  const authorization = { authorization: `Bearer ${ticket}` };
  const status = await fetch(`${origin}/api/publications/${publicationId}`, { headers: authorization });
  assert.equal(status.status, 200, "the author ticket can read its publication");
  const publication = await status.json() as Record<string, unknown>;
  assert.equal(publication.id, publicationId);
  assert.equal(typeof publication.revision, "number");
  assert.equal(typeof publication.digest, "string");
  const candidateAppId = (publication.preview as Record<string, unknown> | undefined)?.id;
  const confirmed = await fetch(`${origin}/api/publications/${publicationId}/confirm`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ revision: publication.revision, digest: publication.digest }),
  });
  assert.equal(confirmed.status, 200, "fixture-author confirmation succeeds");
  const result = await confirmed.json() as Record<string, unknown>;
  assert.equal(result.status, "registered");
  assert.equal(result.appId, candidateAppId);
  assert.equal(typeof result.appId, "string");
  return { appId: result.appId as string, publicationId };
}

function gitLabWriteCounts(gitlab: Awaited<ReturnType<typeof startManagedGitLabFixture>>) {
  return {
    projects: gitlab.state.projects.size,
    projectCreates: gitlab.state.writes.filter((item) => item.method === "POST" && item.path === "/api/v4/projects").length,
    commits: gitlab.state.commitCreateCount,
    tags: gitlab.state.writes.filter((item) => item.method === "POST" && item.path.endsWith("/repository/tags")).length,
    releases: gitlab.state.writes.filter((item) => item.method === "POST" && item.path.endsWith("/releases")).length,
  };
}

test("publisher CLI revises an unconfirmed preview and resumes the same legacy failed request", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "plaza-unconfirmed-http-"));
  const portal = await startManagedPortal();
  t.after(async () => { await portal.close(); await rm(temporary, { recursive: true, force: true }); });
  const projectRoot = await makeProject(temporary);
  const contract = await (await fetch(`${portal.origin}/api/publish-contract`)).json() as { managed: { publisherUrl: string } };
  const helperPath = path.join(temporary, "publisher-cli.py");
  await writeFile(helperPath, await (await fetch(contract.managed.publisherUrl)).text(), "utf8");
  const args = ["--origin", portal.origin, "--project", projectRoot, "--state-dir", path.join(temporary, "private-state")];
  const firstRun = await runCli(helperPath, args);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const first = cliJson(firstRun.stdout);
  const managedId = first.managedAppId as string;
  const project = portal.gitlab.state.projects.get(100)!;
  const oldSha = project.tags.get("v1.0.0")!;
  await writeVersion(projectRoot, "1.0.1", "首次预览的资料修正。", 'export const release = "corrected";\n');
  const updateArgs = [...args, "--managed-app-id", managedId];
  portal.gitlab.state.rejectNextCommitStatus = 503;
  const failed = await runCli(helperPath, updateArgs);
  assert.notEqual(failed.code, 0);
  const original = portal.submissions.at(-1)!;
  assert.equal(original.body.expectedAppRevision, 0);
  await portal.db.query("UPDATE managed_publish_operations SET base_commit_sha = NULL WHERE binding_id = $1 AND tag = 'v1.0.1'", [managedId]);
  const resumed = await runCli(helperPath, updateArgs);
  assert.equal(resumed.code, 0, resumed.stderr);
  const result = cliJson(resumed.stdout);
  assert.equal(result.status, "preview_ready");
  assert.equal(result.managedAppId, managedId);
  const retried = portal.submissions.at(-1)!;
  assert.equal(retried.idempotencyKey, original.idempotencyKey);
  assert.equal(retried.ownerKey, original.ownerKey);
  assert.deepEqual(retried.body, original.body);
  const repeat = await runCli(helperPath, updateArgs);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(cliJson(repeat.stdout).previewUrl, result.previewUrl);
  assert.equal(project.commits.size, 2);
  assert.equal(project.tags.get("v1.0.0"), oldSha);
  assert.equal(project.releases.get("v1.0.0"), oldSha);
  assert.deepEqual(gitLabWriteCounts(portal.gitlab), { projects: 1, projectCreates: 1, commits: 3, tags: 2, releases: 2 });
  assert.equal((await (await fetch(`${portal.origin}/api/apps`)).json() as { total: number }).total, 0);
  assert.ok(!resumed.stdout.includes(MANAGED_GITLAB_TOKEN) && !resumed.stderr.includes(MANAGED_GITLAB_TOKEN));
});

test("managed HTTP flow uploads a local project, confirms and updates one app without leaking the server token", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "plaza-managed-http-"));
  let portal: ManagedPortal | undefined;
  t.after(async () => {
    await portal?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const projectRoot = await makeProject(temporary);
  assert.ok(!(await readdir(projectRoot)).includes(".git"), "fixture project starts without a Git directory");
  portal = await startManagedPortal();

  const contractResponse = await fetch(`${portal.origin}/api/publish-contract`);
  assert.equal(contractResponse.status, 200);
  const contractText = await contractResponse.text();
  const contract = JSON.parse(contractText) as {
    mode: string;
    schema: object;
    managed: { publisherUrl: string; publisherSha256: string };
  };
  assert.equal(contract.mode, "managed");
  const helperResponse = await fetch(contract.managed.publisherUrl);
  assert.equal(helperResponse.status, 200);
  const helperText = await helperResponse.text();
  const helperSha = createHash("sha256").update(helperText, "utf8").digest("hex");
  assert.equal(helperResponse.headers.get("x-content-sha256"), helperSha);
  assert.equal(contract.managed.publisherSha256, helperSha);
  assert.ok(!contractText.includes(MANAGED_GITLAB_TOKEN), "schema and helper metadata do not expose the server-side GitLab token");
  assert.ok(!helperText.includes(MANAGED_GITLAB_TOKEN), "downloaded publisher helper contains no server-side GitLab token");
  const helperPath = path.join(temporary, "publisher-cli.py");
  await writeFile(helperPath, helperText, "utf8");

  const stateDir = path.join(temporary, "private-state");
  const args = ["--origin", portal.origin, "--project", projectRoot, "--state-dir", stateDir];
  const firstRun = await runCli(helperPath, args);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const first = cliJson(firstRun.stdout);
  assert.equal(first.status, "preview_ready");
  assert.equal(first.sourceUploaded, true);
  assert.equal(typeof first.managedAppId, "string");
  assert.ok(!Object.hasOwn(first, "ticket"));
  const firstPreview = previewCapabilities(first.previewUrl, portal.origin);
  assert.ok(!firstRun.stdout.includes(MANAGED_GITLAB_TOKEN) && !firstRun.stderr.includes(MANAGED_GITLAB_TOKEN));
  assert.equal((await (await fetch(`${portal.origin}/api/apps`)).json() as { total: number }).total, 0,
    "uploaded source remains absent from the public app directory before author confirmation");

  const firstSubmission = portal.submissions[0]!;
  assert.ok(firstSubmission.ownerKey.length >= 43);
  assert.equal(firstSubmission.body.appKey, APP_KEY);
  assert.ok(!firstSubmission.headersJson.includes(MANAGED_GITLAB_TOKEN));
  assert.ok(!JSON.stringify(firstSubmission.body).includes(MANAGED_GITLAB_TOKEN));
  const managedId = first.managedAppId as string;
  const denied = await fetch(`${portal.origin}/api/managed-apps/${managedId}/status`, {
    headers: { "x-plaza-publish-key": randomBytes(32).toString("base64url") },
  });
  const deniedBody = await denied.text();
  assert.equal(denied.status, 403, deniedBody);
  assert.ok(!deniedBody.includes(APP_KEY) && !deniedBody.includes(MANAGED_GITLAB_TOKEN));
  const authorizedStatusResponse = await fetch(`${portal.origin}/api/managed-apps/${managedId}/status`, {
    headers: { "x-plaza-publish-key": firstSubmission.ownerKey },
  });
  assert.equal(authorizedStatusResponse.status, 200);
  const pendingStatus = await authorizedStatusResponse.json() as Record<string, unknown>;
  assert.deepEqual(pendingStatus, {
    managedAppId: managedId,
    appKey: APP_KEY,
    projectId: "100",
    revision: 0,
  });

  const initialCounts = gitLabWriteCounts(portal.gitlab);
  assert.deepEqual(initialCounts, { projects: 1, projectCreates: 1, commits: 1, tags: 1, releases: 1 });
  const duplicateRun = await runCli(helperPath, args);
  assert.equal(duplicateRun.code, 0, duplicateRun.stderr);
  const duplicate = cliJson(duplicateRun.stdout);
  const duplicatePreview = previewCapabilities(duplicate.previewUrl, portal.origin);
  assert.ok(duplicatePreview.publicationId === firstPreview.publicationId && duplicatePreview.ticket === firstPreview.ticket,
    "retry uses the same author preview capability");
  assert.ok(portal.submissions[0]!.ownerKey === portal.submissions[1]!.ownerKey, "the same local receipt owner key is reused");
  assert.equal(portal.submissions[0]!.idempotencyKey, portal.submissions[1]!.idempotencyKey);
  assert.deepEqual(gitLabWriteCounts(portal.gitlab), initialCounts, "idempotent retry creates no extra repository, commit, tag, or release");

  const confirmed = await confirmPreview(portal.origin, first.previewUrl);
  const confirmedStatusResponse = await fetch(`${portal.origin}/api/managed-apps/${managedId}/status`, {
    headers: { "x-plaza-publish-key": firstSubmission.ownerKey },
  });
  assert.equal(confirmedStatusResponse.status, 200);
  const confirmedStatus = await confirmedStatusResponse.json() as Record<string, unknown>;
  assert.equal(confirmedStatus.appId, confirmed.appId);
  assert.equal(confirmedStatus.revision, 1);
  assert.equal(confirmedStatus.version, "1.0.0");
  const afterFirstConfirm = await (await fetch(`${portal.origin}/api/apps`)).json() as { items: Array<{ id: string; version: string }>; total: number };
  assert.equal(afterFirstConfirm.total, 1);
  assert.equal(afterFirstConfirm.items[0]?.id, confirmed.appId);
  assert.equal(afterFirstConfirm.items[0]?.version, "1.0.0");

  await writeVersion(projectRoot, "1.1.0", "新增批量转换和格式核验能力。", 'export const release = "two";\n');
  const updateRun = await runCli(helperPath, [...args, "--managed-app-id", managedId]);
  assert.equal(updateRun.code, 0, updateRun.stderr);
  const update = cliJson(updateRun.stdout);
  assert.equal(update.status, "preview_ready");
  assert.equal(update.managedAppId, managedId);
  const updatePreview = previewCapabilities(update.previewUrl, portal.origin);
  assert.notEqual(updatePreview.publicationId, firstPreview.publicationId);
  const updateSubmission = portal.submissions.at(-1)!;
  assert.equal(updateSubmission.body.managedAppId, managedId);
  assert.equal(updateSubmission.body.expectedAppRevision, 1);
  assert.ok(updateSubmission.ownerKey === firstSubmission.ownerKey, "managed updates retain the receipt owner key");
  assert.notEqual(updateSubmission.idempotencyKey, firstSubmission.idempotencyKey);
  assert.equal(portal.statusKeys.at(-1), firstSubmission.ownerKey, "CLI reads current status using the owner credential");
  const stillConfirmedStatus = await (await fetch(`${portal.origin}/api/managed-apps/${managedId}/status`, {
    headers: { "x-plaza-publish-key": firstSubmission.ownerKey },
  })).json() as Record<string, unknown>;
  assert.equal(stillConfirmedStatus.appId, confirmed.appId);
  assert.equal(stillConfirmedStatus.revision, 1, "a pending update does not replace the confirmed version");
  assert.equal(stillConfirmedStatus.version, "1.0.0");
  assert.deepEqual(gitLabWriteCounts(portal.gitlab), { projects: 1, projectCreates: 1, commits: 2, tags: 2, releases: 2 });

  const updatedConfirmed = await confirmPreview(portal.origin, update.previewUrl);
  assert.equal(updatedConfirmed.appId, confirmed.appId, "confirmed update stays on the same public app");
  const updatedStatus = await (await fetch(`${portal.origin}/api/managed-apps/${managedId}/status`, {
    headers: { "x-plaza-publish-key": firstSubmission.ownerKey },
  })).json() as Record<string, unknown>;
  assert.equal(updatedStatus.managedAppId, managedId);
  assert.equal(updatedStatus.appId, confirmed.appId);
  assert.equal(updatedStatus.revision, 2);
  assert.equal(updatedStatus.version, "1.1.0");
  const finalDirectory = await (await fetch(`${portal.origin}/api/apps`)).json() as { items: Array<{ id: string; version: string }>; total: number };
  assert.equal(finalDirectory.total, 1);
  assert.equal(finalDirectory.items[0]?.id, confirmed.appId);
  assert.equal(finalDirectory.items[0]?.version, "1.1.0");
  assert.deepEqual(gitLabWriteCounts(portal.gitlab), { projects: 1, projectCreates: 1, commits: 2, tags: 2, releases: 2 });

  const binding = (await portal.db.query<{ publish_key_digest: string }>(
    "SELECT publish_key_digest FROM managed_app_bindings WHERE id = $1", [managedId],
  )).rows[0]!;
  assert.match(binding.publish_key_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(binding.publish_key_digest, firstSubmission.ownerKey);
  const project = portal.gitlab.state.projects.get(100)!;
  for (const commit of project.commits.values()) {
    for (const bytes of commit.files.values()) {
      assert.ok(!Buffer.from(bytes).includes(Buffer.from(MANAGED_GITLAB_TOKEN)), "GitLab service token is never uploaded as project content");
    }
  }
  for (const run of [firstRun, duplicateRun, updateRun]) {
    assert.ok(!run.stdout.includes(MANAGED_GITLAB_TOKEN) && !run.stderr.includes(MANAGED_GITLAB_TOKEN));
    assert.ok(!run.stdout.includes(firstSubmission.ownerKey) && !run.stderr.includes(firstSubmission.ownerKey));
  }
});
