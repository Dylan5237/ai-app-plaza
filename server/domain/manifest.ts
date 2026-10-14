import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import { DomainError } from "./errors.js";
import { validateCapabilityTags } from './tags.js';
import { parseTree, type ParseError, type Node as JsonNode } from "jsonc-parser";

export interface WebEntry {
  id: string;
  kind: "web";
  label: string;
  url: string;
}

export interface AgentEntry {
  id: string;
  kind: "agent";
  label: string;
  instructionsPath: string;
  compatibility: string[];
  artifacts?: Array<{ url: string; sha256: string }>;
}

export type ManifestEntry = WebEntry | AgentEntry;

export interface Maintainer {
  name: string;
  nameEn: string;
}

export interface AppManifest {
  schemaVersion: "2";
  appKey: string;
  name: string;
  summary: string;
  projectVersion: string;
  tags: string[];
  maintainers: Maintainer[];
  capabilities: { scenarios: string[]; inputs: string[]; outputs: string[] };
  examples: Array<{ request: string; expectedResult: string }>;
  requirements: string[];
  limitations: string[];
  docs: { readme: string; usage: string };
  entries: ManifestEntry[];
  primaryEntry: string;
}

export type StoredAppManifest = AppManifest | (Omit<AppManifest, "schemaVersion" | "projectVersion" | "maintainers"> & {
  schemaVersion: "1";
  projectVersion?: string;
  maintainers: string[];
});

const schemaText = readFileSync(new URL("../contracts/app-manifest.schema.json", import.meta.url), "utf8");
const schema = JSON.parse(schemaText) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = (formatsModule as unknown as { default: (validator: Ajv2020) => void }).default;
addFormats(ajv);
const validateSchema = ajv.compile<AppManifest>(schema);

export function decodeUtf8(bytes: Uint8Array, subject = "文件"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError(400, "VALIDATION_FAILED", `${subject}必须是有效的 UTF-8 文本。`);
  }
}

export function parseStrictJson(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const fail = (): never => { throw new DomainError(400, "VALIDATION_FAILED", "Manifest 不是有效 JSON，或包含重复键。"); };
  if (!tree || errors.length) return fail();
  function check(node: JsonNode, depth: number): void {
    if (depth > 64) fail();
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (keys.has(key)) fail();
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child, depth + 1);
  }
  check(tree, 0);
  return JSON.parse(text);
}

export function validateRepoPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.startsWith("/")) {
    throw new DomainError(400, "VALIDATION_FAILED", `${label}必须是仓库根目录下的相对路径。`);
  }
  if (value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError(400, "VALIDATION_FAILED", `${label}包含不允许的字符。`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new DomainError(400, "VALIDATION_FAILED", `${label}包含不安全的路径段。`);
  }
  return value;
}

export function validateManifest(value: unknown, expectedAppKey: string): AppManifest {
  if (value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === "1") {
    throw new DomainError(400, "VALIDATION_FAILED", "新发布资料需要使用 schemaVersion 2。请先读取 GET /api/publish-contract；历史已收录的 v1 快照仍按原样保留。请勿从 GitLab 用户名、邮箱或 Git 配置推测作者姓名。");
  }
  if (value && typeof value === "object") {
    validateCapabilityTags((value as { tags?: unknown }).tags);
    const candidate = value as { projectVersion?: unknown; maintainers?: unknown };
    if (typeof candidate.projectVersion !== "string" || !normalizeProjectVersion(candidate.projectVersion)) {
      throw new DomainError(400, "VALIDATION_FAILED", "projectVersion 必须是有效的 MAJOR.MINOR.PATCH，可带 v 前缀和合法预发布号，例如 1.2.3 或 v1.2.3-rc.1；请确保它与 GitLab tag 和 Release 一致。");
    }
    if (Array.isArray(candidate.maintainers)) {
      for (const maintainer of candidate.maintainers) {
        const names = maintainer && typeof maintainer === "object" ? maintainer as { name?: unknown; nameEn?: unknown } : {};
        if (typeof names.name !== "string" || !names.name.trim() || typeof names.nameEn !== "string" || !names.nameEn.trim()) {
          throw new DomainError(400, "VALIDATION_FAILED", "每位作者都必须填写中文姓名和英文全名或完整拼音；缺失时请先询问作者，不要根据 GitLab 或 Git 配置猜测。");
        }
      }
    }
  }
  if (!validateSchema(value)) {
    const issue = validateSchema.errors?.[0];
    const field = issue?.instancePath ? `（${issue.instancePath}）` : "";
    throw new DomainError(400, "VALIDATION_FAILED", `Manifest 不符合 ai-app.json 契约${field}。`);
  }
  const manifest = value as AppManifest;
  if (manifest.appKey !== expectedAppKey) {
    throw new DomainError(400, "VALIDATION_FAILED", "请求中的 appKey 与 Manifest 不一致。");
  }

  const seenStrings = new WeakSet<object>();
  function checkText(current: unknown): void {
    if (typeof current === "string") {
      if (!current.trim()) throw new DomainError(400, "VALIDATION_FAILED", "Manifest 的文本字段不能为空白。");
      return;
    }
    if (current && typeof current === "object") {
      if (seenStrings.has(current)) return;
      seenStrings.add(current);
      if (Array.isArray(current)) current.forEach(checkText);
      else Object.values(current).forEach(checkText);
    }
  }
  checkText(manifest);

  const entryIds = new Set<string>();
  for (const entry of manifest.entries) {
    if (entryIds.has(entry.id)) throw new DomainError(400, "VALIDATION_FAILED", "Manifest 中的入口 ID 必须唯一。");
    entryIds.add(entry.id);
    if (entry.kind === "agent") validateRepoPath(entry.instructionsPath, "Agent 接入说明路径");
  }
  if (!entryIds.has(manifest.primaryEntry)) {
    throw new DomainError(400, "VALIDATION_FAILED", "primaryEntry 必须指向已声明的入口。");
  }

  validateRepoPath(manifest.docs.readme, "docs.readme");
  validateRepoPath(manifest.docs.usage, "docs.usage");

  const urls = [
    ...manifest.entries.filter((entry): entry is WebEntry => entry.kind === "web").map((entry) => entry.url),
    ...manifest.entries.filter((entry): entry is AgentEntry => entry.kind === "agent")
      .flatMap((entry) => entry.artifacts?.map((artifact) => artifact.url) ?? []),
  ];
  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new DomainError(400, "VALIDATION_FAILED", "入口或产物 URL 格式无效。");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new DomainError(400, "VALIDATION_FAILED", "入口或产物 URL 只能使用不含凭据的 HTTP(S) 地址。");
    }
  }
  return manifest;
}

export function normalizeProjectVersion(value: string): string | undefined {
  if (!/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?![\s\S])/.test(value)) return undefined;
  return value.startsWith("v") ? value.slice(1) : value;
}

/** Compare the version format supported by our manifest, including prereleases. */
export function compareProjectVersions(left: string, right: string): number | undefined {
  const a = normalizeProjectVersion(left)?.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/);
  const b = normalizeProjectVersion(right)?.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/);
  if (!a || !b) return undefined;
  const numeric = (x: string, y: string) => BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const difference = numeric(a[i]!, b[i]!);
    if (difference) return difference;
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i], r = y[i];
    if (l === r) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return numeric(l, r);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function manifestJson(text: string, expectedAppKey: string): AppManifest {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(400, "VALIDATION_FAILED", "Manifest 不是有效 JSON。");
  }
  return validateManifest(parsed, expectedAppKey);
}
