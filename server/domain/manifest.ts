import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import { DomainError } from "./errors.js";

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

export interface AppManifest {
  schemaVersion: "1";
  appKey: string;
  name: string;
  summary: string;
  projectVersion?: string;
  tags: string[];
  maintainers: string[];
  capabilities: { scenarios: string[]; inputs: string[]; outputs: string[] };
  examples: Array<{ request: string; expectedResult: string }>;
  requirements: string[];
  limitations: string[];
  docs: { readme: string; usage: string };
  entries: ManifestEntry[];
  primaryEntry: string;
}

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
  let cursor = 0;

  function fail(): never {
    throw new DomainError(400, "VALIDATION_FAILED", "Manifest 不是有效 JSON，或包含重复键。");
  }

  function whitespace(): void {
    while (cursor < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[cursor]!)) cursor++;
  }

  function parseString(): string {
    if (text[cursor] !== '"') return fail();
    const start = cursor++;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x22) {
        cursor++;
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          return fail();
        }
      }
      if (code < 0x20) return fail();
      if (code === 0x5c) {
        cursor++;
        const escaped = text[cursor];
        if (escaped === "u") {
          const hex = text.slice(cursor + 1, cursor + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail();
          cursor += 5;
          continue;
        }
        if (!escaped || !/["\\/bfnrt]/.test(escaped)) return fail();
      }
      cursor++;
    }
    return fail();
  }

  function parseValue(depth: number): unknown {
    if (depth > 64) return fail();
    whitespace();
    const current = text[cursor];
    if (current === '"') return parseString();
    if (current === "{") {
      cursor++;
      whitespace();
      const value: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        cursor++;
        return value;
      }
      while (cursor < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) return fail();
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ":") return fail();
        const member = parseValue(depth + 1);
        Object.defineProperty(value, key, { value: member, enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[cursor] === "}") {
          cursor++;
          return value;
        }
        if (text[cursor++] !== ",") return fail();
      }
      return fail();
    }
    if (current === "[") {
      cursor++;
      whitespace();
      const values: unknown[] = [];
      if (text[cursor] === "]") {
        cursor++;
        return values;
      }
      while (cursor < text.length) {
        values.push(parseValue(depth + 1));
        whitespace();
        if (text[cursor] === "]") {
          cursor++;
          return values;
        }
        if (text[cursor++] !== ",") return fail();
      }
      return fail();
    }
    for (const [token, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(token, cursor)) {
        cursor += token.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor));
    if (number) {
      cursor += number[0].length;
      return Number(number[0]);
    }
    return fail();
  }

  const value = parseValue(0);
  whitespace();
  if (cursor !== text.length) return fail();
  return value;
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
  const normalizedTags = new Set<string>();
  for (const tag of manifest.tags) {
    const key = tag.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    if (normalizedTags.has(key)) throw new DomainError(400, "VALIDATION_FAILED", "标签规范化后不能重复。");
    normalizedTags.add(key);
  }

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
