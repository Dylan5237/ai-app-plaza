import { createHash, randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../server/app.js";
import type { Config } from "../../server/config.js";
import { openDatabase } from "../../server/domain/database.js";
import { manifest } from "./gitlab-fixture.js";
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from "./managed-gitlab-fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const PORTAL_SECRET = "managed-safety-flow-test-secret-with-32-bytes";
const SAFE_LOOPBACK_PORT_MIN = 15_001;
const SAFE_LOOPBACK_PORT_MAX = 65_535;
const NODE_FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87,
  95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6697, 10080,
]);
const TABLES = [
  "catalog_apps",
  "published_snapshots",
  "publications",
  "managed_app_bindings",
  "managed_publish_operations",
  "catalog_tag_overrides",
  "catalog_tag_cleanup_operations",
] as const;

export const SYNTHETIC_LEGACY_REFERENCE_FIXTURE = {
  id: "synthetic-managed-publish-client-loss-chain",
  provenance: "synthetic-reference-only; no historical request or response bytes were captured",
  projectCreateRejectionStatus: 400,
  projectReadbackUnavailableStatus: 503,
  exactRequestReplay: false,
  exactResponseReplay: false,
} as const;

export const SERVER_ONLY_SENTINEL = MANAGED_GITLAB_TOKEN;

export interface SafetyRequest {
  method: string;
  path: string;
  ownerKey?: string;
  idempotencyKey?: string;
  bodyPresent: boolean;
  body?: unknown;
}

export interface SafetyPortal {
  origin: string;
  app: Awaited<ReturnType<typeof createApp>>["app"];
  db: Awaited<ReturnType<typeof openDatabase>>;
  gitlab: Awaited<ReturnType<typeof startManagedGitLabFixture>>;
  requests: SafetyRequest[];
  dropNextSubmitResponse(): void;
  close(): Promise<void>;
}

export interface SafetyHttpResponse {
  status: number;
  text: string;
  json: Record<string, any>;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 96; attempt++) {
    const port = randomInt(SAFE_LOOPBACK_PORT_MIN, SAFE_LOOPBACK_PORT_MAX + 1);
    if (NODE_FETCH_BLOCKED_PORTS.has(port)) continue;
    const probe = createServer();
    const available = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!available) continue;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }
  throw new Error("Unable to allocate an available Node-fetch-compatible loopback test port.");
}

export async function startSafetyPortal(): Promise<SafetyPortal> {
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const db = await openDatabase({ path: "memory://" });
  const gitlab = await startManagedGitLabFixture();
  const config: Config = {
    host: "127.0.0.1",
    port,
    publicOrigin: origin,
    gitlabUrl: gitlab.url,
    secret: PORTAL_SECRET,
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
  const requests: SafetyRequest[] = [];
  let dropSubmitResponse = false;
  app.addHook("preHandler", async (request) => {
    const route = request.url.split("?", 1)[0]!;
    if ((request.method === "POST" && [
      "/api/managed-publications/validate",
      "/api/managed-publications",
    ].includes(route)) || (request.method === "GET" && route === "/api/managed-publications/receipt")) {
      const body = request.body === undefined ? undefined : JSON.parse(JSON.stringify(request.body)) as unknown;
      requests.push({
        method: request.method,
        path: route,
        ownerKey: typeof request.headers["x-plaza-publish-key"] === "string"
          ? request.headers["x-plaza-publish-key"]
          : undefined,
        idempotencyKey: typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined,
        bodyPresent: request.body !== undefined,
        ...(body === undefined ? {} : { body }),
      });
    }
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    if (dropSubmitResponse && request.method === "POST" && request.url.split("?", 1)[0] === "/api/managed-publications") {
      dropSubmitResponse = false;
      request.raw.socket.destroy();
    }
    return payload;
  });
  await app.listen({ port, host: "127.0.0.1" });
  return {
    origin,
    app,
    db,
    gitlab,
    requests,
    dropNextSubmitResponse: () => { dropSubmitResponse = true; },
    close: async () => { await app.close(); await db.close(); await gitlab.close(); },
  };
}

export function makeSafetyManifest(appKey: string) {
  return {
    ...manifest(1),
    appKey,
    name: "合成托管发布安全回归",
    docs: { readme: "README.md", usage: "docs/usage.md" },
    entries: [{ id: "web", kind: "web" as const, label: "打开合成应用", url: "https://example.invalid/safety-flow" }],
    primaryEntry: "web",
  };
}

export function makeSafetyBundle(appKey: string, includeServerOnlySentinel = false): Record<string, unknown> {
  const files = [
    { path: "ai-app.json", text: JSON.stringify(makeSafetyManifest(appKey), null, 2) },
    { path: "README.md", text: "# 合成应用\n\n三文件最小合法发布包。\n" },
    { path: "docs/usage.md", text: "# 使用说明\n\n仅用于隔离回归。\n" },
    ...(includeServerOnlySentinel ? [{
      path: "src/server-only.ts",
      text: `export const fixtureNote = ${JSON.stringify(SERVER_ONLY_SENTINEL)};\n`,
    }] : []),
  ];
  return {
    appKey,
    manifestPath: "ai-app.json",
    files: files.map(({ path: filePath, text }) => ({
      path: filePath,
      content: Buffer.from(text, "utf8").toString("base64"),
    })),
  };
}

export async function writeSafetyProject(parent: string, appKey: string, includeServerOnlySentinel = false): Promise<string> {
  const root = path.join(parent, "synthetic-app");
  const bundle = makeSafetyBundle(appKey, includeServerOnlySentinel) as {
    files: Array<{ path: string; content: string }>;
  };
  for (const file of bundle.files) {
    const destination = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.content, "base64"));
  }
  return root;
}

export async function downloadPublisherCli(origin: string, destination: string): Promise<string> {
  const contractResponse = await fetch(`${origin}/api/publish-contract`);
  if (!contractResponse.ok) throw new Error(`publish contract returned HTTP ${contractResponse.status}`);
  const contract = await contractResponse.json() as {
    managed?: { publisherUrl?: string; publisherSha256?: string };
  };
  if (typeof contract.managed?.publisherUrl !== "string" || typeof contract.managed.publisherSha256 !== "string") {
    throw new Error("managed publish contract does not identify its publisher CLI");
  }
  const scriptResponse = await fetch(new URL(contract.managed.publisherUrl, origin));
  if (!scriptResponse.ok) throw new Error(`publisher CLI returned HTTP ${scriptResponse.status}`);
  const script = await scriptResponse.text();
  const digest = createHash("sha256").update(script, "utf8").digest("hex");
  if (digest !== contract.managed.publisherSha256 || digest !== scriptResponse.headers.get("x-content-sha256")) {
    throw new Error("downloaded publisher CLI does not match its advertised digest");
  }
  await writeFile(destination, script, "utf8");
  return destination;
}

export function runPublisherCli(scriptPath: string, args: string[]): Promise<CliResult> {
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

export async function safetyResponse(response: Response): Promise<SafetyHttpResponse> {
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
}

export async function validateSafetyBundle(portal: SafetyPortal, bundle: Record<string, unknown>): Promise<SafetyHttpResponse> {
  return safetyResponse(await fetch(`${portal.origin}/api/managed-publications/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle),
  }));
}

export async function submitSafetyBundle(
  portal: SafetyPortal,
  bundle: Record<string, unknown>,
  ownerKey: string,
  idempotencyKey: string,
): Promise<SafetyHttpResponse> {
  return safetyResponse(await fetch(`${portal.origin}/api/managed-publications`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-plaza-publish-key": ownerKey,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(bundle),
  }));
}

export async function getSafetyReceipt(
  portal: SafetyPortal,
  ownerKey: string,
  idempotencyKey: string,
): Promise<SafetyHttpResponse> {
  return safetyResponse(await fetch(`${portal.origin}/api/managed-publications/receipt`, {
    method: "GET",
    headers: {
      "x-plaza-publish-key": ownerKey,
      "idempotency-key": idempotencyKey,
    },
  }));
}

export async function businessTableSnapshot(portal: SafetyPortal): Promise<Record<string, string[]>> {
  const snapshot: Record<string, string[]> = {};
  for (const table of TABLES) {
    const result = await portal.db.query<{ row_json: string }>(
      `SELECT to_jsonb(row_value)::text AS row_json FROM ${table} AS row_value`,
    );
    snapshot[table] = result.rows
      .map(({ row_json }) => createHash("sha256").update(row_json, "utf8").digest("hex"))
      .sort();
  }
  return snapshot;
}

export function gitlabWriteCalls(portal: SafetyPortal): Array<{ method: string; path: string }> {
  return portal.gitlab.state.writes.map(({ method, path: requestPath }) => ({ method, path: requestPath }));
}

export interface ReceiptDirectorySnapshot {
  exists: boolean;
  kind: "missing" | "directory" | "other";
  entries: Array<{ name: string; kind: "file" | "directory" | "symlink" | "other"; bytes?: number; sha256?: string }>;
}

export async function receiptDirectorySnapshot(directory: string): Promise<ReceiptDirectorySnapshot> {
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      return { exists: true, kind: "other", entries: [] };
    }
    const entries = [];
    for (const name of await readdir(directory)) {
      const entryPath = path.join(directory, name);
      const entryInfo = await lstat(entryPath);
      if (entryInfo.isSymbolicLink()) {
        entries.push({ name, kind: "symlink" as const });
      } else if (entryInfo.isDirectory()) {
        entries.push({ name, kind: "directory" as const });
      } else if (entryInfo.isFile()) {
        const bytes = await readFile(entryPath);
        entries.push({
          name,
          kind: "file" as const,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        entries.push({ name, kind: "other" as const });
      }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { exists: true, kind: "directory", entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, kind: "missing", entries: [] };
    throw new Error("Unable to inspect the synthetic private receipt directory safely.");
  }
}

export function newPublishKey(): string {
  return randomBytes(32).toString("base64url");
}
