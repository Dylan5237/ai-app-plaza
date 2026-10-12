import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { decodeUtf8, manifestJson, normalizeProjectVersion, validateRepoPath, type AppManifest } from "./manifest.js";

export interface SourceInput {
  projectId: string | number;
  appKey: string;
  manifestPath: string;
  commitSha: string;
  tag: string;
}

export interface AppSource {
  projectId: string;
  projectUrl: string;
  commitSha: string;
  manifestPath: string;
  tag?: string;
}

export interface LoadedSource {
  manifest: AppManifest;
  documents: Record<string, string>;
  digest: string;
  version: string;
  source: AppSource;
  sourceCreatedAt: string;
}

interface GitLabUser {
  id?: number | string;
}

interface GitLabProject {
  id?: number | string;
  created_at?: string;
  web_url?: string;
  permissions?: {
    project_access?: { access_level?: number } | null;
    group_access?: { access_level?: number } | null;
  };
}

interface GitLabCommit {
  id?: string;
}

interface GitLabTag {
  commit?: { id?: string };
}

interface GitLabRelease {
  tag_name?: string;
  commit?: { id?: string };
}

interface GitLabTreeEntry {
  name?: string;
  type?: string;
  mode?: string;
}

class GitLabHttpError extends Error {
  constructor(readonly status: number) {
    super("GitLab API request failed.");
  }
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_API_BYTES = 1024 * 1024;
const MAX_TREE_PAGES = 10;
const REQUEST_TIMEOUT_MS = 8_000;
const LOAD_TIMEOUT_MS = 30_000;
const MAX_LOAD_REQUESTS = 80;

interface RequestBudget {
  deadline: number;
  requests: number;
}

export class GitLabSourceReader {
  readonly baseUrl: URL;

  constructor(gitlabUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(gitlabUrl);
    } catch {
      throw new Error("A configured GitLab URL is required.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("GitLab URL must use HTTP(S) and must not contain credentials or query data.");
    }
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
    this.baseUrl = parsed;
  }

  async currentUser(token: string): Promise<{ actorId: string }> {
    const user = await this.getJson<GitLabUser>("api/v4/user", token);
    if ((typeof user.id !== "number" && typeof user.id !== "string") || !String(user.id).trim()) {
      throw new DomainError(401, "AUTH_TOKEN_INVALID", "GitLab 授权无法识别当前用户。");
    }
    return { actorId: String(user.id) };
  }

  async load(input: SourceInput, token: string): Promise<LoadedSource> {
    const budget: RequestBudget = { deadline: performance.now() + LOAD_TIMEOUT_MS, requests: 0 };
    const projectId = validateProjectId(input.projectId);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.appKey) || input.appKey.length > 64) {
      throw new DomainError(400, "VALIDATION_FAILED", "appKey 格式无效。");
    }
    const manifestPath = validateRepoPath(input.manifestPath, "Manifest 路径");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.commitSha)) {
      throw new DomainError(400, "VALIDATION_FAILED", "commitSha 必须是完整 Git commit SHA。");
    }
    if (!isSupportedReleaseTag(input.tag)) {
      throw new DomainError(400, "VALIDATION_FAILED", "必须提供符合 MAJOR.MINOR.PATCH 的版本 tag（可带 v 前缀和合法预发布号），并为其创建正式 GitLab Release。");
    }
    const commitSha = input.commitSha.toLowerCase();

    const project = await this.getProject(projectId, token, budget);
    if (String(project.id) !== projectId) {
      throw new DomainError(502, "SOURCE_UNAVAILABLE", "GitLab 返回的项目标识与请求不一致。");
    }
    const projectAccess = project.permissions?.project_access?.access_level ?? 0;
    const groupAccess = project.permissions?.group_access?.access_level ?? 0;
    if (Math.max(projectAccess, groupAccess) < 40) {
      throw new DomainError(403, "PERMISSION_DENIED", "当前 GitLab 用户需要对项目拥有 Maintainer 或 Owner 权限。");
    }

    let commit: GitLabCommit;
    try {
      commit = await this.getJson<GitLabCommit>(
        `api/v4/projects/${projectId}/repository/commits/${encodeURIComponent(commitSha)}`,
        token,
        budget,
      );
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) {
        throw new DomainError(400, "VALIDATION_FAILED", "GitLab 项目中不存在请求的固定 commit。");
      }
      throw error;
    }
    if (commit.id?.toLowerCase() !== commitSha) {
      throw new DomainError(400, "VALIDATION_FAILED", "GitLab 未返回与请求一致的固定 commit。");
    }

    let tag: GitLabTag;
    try {
      tag = await this.getJson<GitLabTag>(
        `api/v4/projects/${projectId}/repository/tags/${encodeURIComponent(input.tag)}`,
        token,
        budget,
      );
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) {
        throw new DomainError(400, "VALIDATION_FAILED", "GitLab 项目中不存在指定版本 tag。请按项目发布流程为目标 commit 创建 tag 和对应 Release 后重新提交候选。");
      }
      throw error;
    }
    if (tag.commit?.id?.toLowerCase() !== commitSha) {
      throw new DomainError(400, "VALIDATION_FAILED", "指定版本 tag 当前未指向请求中的 commit，可能已移动。请为正确 commit 准备新的匹配版本 tag/Release 后重新提交候选。");
    }

    let release: GitLabRelease;
    try {
      release = await this.getJson<GitLabRelease>(
        `api/v4/projects/${projectId}/releases/${encodeURIComponent(input.tag)}`,
        token,
        budget,
      );
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) {
        throw new DomainError(400, "VALIDATION_FAILED", "该版本 tag 尚无正式 GitLab Release。请作者 Agent 使用已有授权按项目发布流程创建此 Release，再用相同 tag 和 commit SHA 重新提交；门户不会代作者操作 GitLab。");
      }
      throw error;
    }
    if (release.tag_name !== input.tag) {
      throw new DomainError(400, "VALIDATION_FAILED", "GitLab Release 返回的版本 tag 与提交不一致。请核对项目版本、tag 和 Release 后重新提交候选。");
    }
    if (release.commit?.id?.toLowerCase() !== commitSha) {
      throw new DomainError(400, "VALIDATION_FAILED", "GitLab Release 关联的 commit 与请求不一致，版本 Release 可能指向旧提交。请勿移动已有 tag；为正确 commit 准备新的匹配版本、tag 和 Release 后重新提交候选。");
    }

    const webUrl = checkedProjectUrl(project.web_url, this.baseUrl);
    const manifestBytes = await this.readRegularBlob(projectId, manifestPath, commitSha, token, MAX_MANIFEST_BYTES, budget);
    const manifestText = decodeUtf8(manifestBytes, "Manifest");
    const manifest = manifestJson(manifestText, input.appKey);
    if (normalizeProjectVersion(manifest.projectVersion) !== normalizeProjectVersion(input.tag)) {
      throw new DomainError(400, "VALIDATION_FAILED", "ai-app.json 的 projectVersion 必须与 GitLab Release tag 表示同一版本（允许可选的 v 前缀）。请更新版本资料、commit、tag 和 Release 后重新提交。");
    }
    const declaredPaths = new Set<string>([manifest.docs.readme, manifest.docs.usage]);
    for (const entry of manifest.entries) {
      if (entry.kind === "agent") declaredPaths.add(entry.instructionsPath);
    }
    const documents: Record<string, string> = {};
    const documentBytes = new Map<string, Uint8Array>();
    let documentBytesTotal = 0;
    for (const filePath of [...declaredPaths].sort()) {
      const bytes = await this.readRegularBlob(projectId, filePath, commitSha, token, MAX_DOCUMENT_BYTES, budget);
      documentBytesTotal += bytes.byteLength;
      if (documentBytesTotal > MAX_DOCUMENT_BYTES) {
        throw new DomainError(400, "VALIDATION_FAILED", "共享说明总大小不能超过 512 KiB。");
      }
      documents[filePath] = decodeUtf8(bytes, "共享说明");
      documentBytes.set(filePath, bytes);
      if (isLfsPointer(bytes)) {
        throw new DomainError(400, "VALIDATION_FAILED", "共享说明不能是 Git LFS 指针文件。");
      }
    }

    const digest = digestFiles(new Map([
      [manifestPath, manifestBytes],
      ...documentBytes,
    ]));
    const sourceCreatedAt = validIsoDate(project.created_at);
    if (!sourceCreatedAt) {
      throw new DomainError(502, "SOURCE_UNAVAILABLE", "GitLab 项目信息缺少有效创建时间。");
    }
    const source: AppSource = {
      projectId,
      projectUrl: webUrl,
      commitSha,
      manifestPath,
      tag: input.tag,
    };
    return {
      manifest,
      documents,
      digest,
      version: manifest.projectVersion,
      source,
      sourceCreatedAt,
    };
  }

  private async getProject(projectId: string, token: string, budget: RequestBudget): Promise<GitLabProject> {
    try {
      return await this.getJson<GitLabProject>(`api/v4/projects/${projectId}`, token, budget);
    } catch (error) {
      if (error instanceof GitLabHttpError && (error.status === 403 || error.status === 404)) {
        throw new DomainError(403, "PERMISSION_DENIED", "当前 GitLab 用户无法读取该项目或其发布权限不足。");
      }
      throw error;
    }
  }

  private async readRegularBlob(projectId: string, filePath: string, commitSha: string, token: string, limit: number, budget: RequestBudget): Promise<Uint8Array> {
    await this.assertRegularFile(projectId, filePath, commitSha, token, budget);
    const url = this.apiUrl(`api/v4/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw`);
    url.searchParams.set("ref", commitSha);
    try {
      return await this.getBytes(url, token, limit, budget);
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) {
        throw new DomainError(400, "VALIDATION_FAILED", "固定 commit 中缺少 Manifest 或其声明的共享文件。");
      }
      throw error;
    }
  }

  private async assertRegularFile(projectId: string, filePath: string, commitSha: string, token: string, budget: RequestBudget): Promise<void> {
    const segments = filePath.split("/");
    let parent = "";
    for (let index = 0; index < segments.length; index++) {
      const name = segments[index]!;
      const entry = await this.findTreeEntry(projectId, parent, name, commitSha, token, budget);
      const isFile = index === segments.length - 1;
      if (isFile && entry.type === "blob" && ["100644", "100755"].includes(entry.mode ?? "")) return;
      if (!isFile && entry.type === "tree" && entry.mode === "040000") {
        parent = parent ? `${parent}/${name}` : name;
        continue;
      }
      throw new DomainError(400, "VALIDATION_FAILED", "共享文件必须是固定 commit 中的普通 UTF-8 文件，不能是符号链接或子模块。");
    }
    throw new DomainError(400, "VALIDATION_FAILED", "固定 commit 中找不到声明的共享文件。");
  }

  private async findTreeEntry(projectId: string, treePath: string, name: string, commitSha: string, token: string, budget: RequestBudget): Promise<GitLabTreeEntry> {
    for (let page = 1; page <= MAX_TREE_PAGES; page++) {
      const url = this.apiUrl(`api/v4/projects/${projectId}/repository/tree`);
      if (treePath) url.searchParams.set("path", treePath);
      url.searchParams.set("ref", commitSha);
      url.searchParams.set("recursive", "false");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      let entries: GitLabTreeEntry[];
      try {
        entries = await this.getJson<GitLabTreeEntry[]>(url, token, budget);
      } catch (error) {
        if (error instanceof GitLabHttpError && error.status === 404) {
          throw new DomainError(400, "VALIDATION_FAILED", "固定 commit 中找不到声明的共享文件。");
        }
        throw error;
      }
      const found = entries.find((entry) => entry.name === name);
      if (found) return found;
      if (entries.length < 100) break;
    }
    throw new DomainError(400, "VALIDATION_FAILED", "固定 commit 中找不到声明的共享文件。");
  }

  private async getJson<T>(pathOrUrl: string | URL, token: string, budget?: RequestBudget): Promise<T> {
    const bytes = await this.getBytes(pathOrUrl, token, MAX_API_BYTES, budget);
    try {
      return JSON.parse(decodeUtf8(bytes, "GitLab 响应")) as T;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, "SOURCE_UNAVAILABLE", "GitLab 返回了无法读取的响应。");
    }
  }

  private async getBytes(pathOrUrl: string | URL, token: string, maxBytes: number, budget?: RequestBudget): Promise<Uint8Array> {
    const url = typeof pathOrUrl === "string" ? this.apiUrl(pathOrUrl) : pathOrUrl;
    let timeoutMs = REQUEST_TIMEOUT_MS;
    if (budget) {
      const remaining = Math.floor(budget.deadline - performance.now());
      if (remaining <= 0 || budget.requests >= MAX_LOAD_REQUESTS) {
        throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 来源核验超过请求时限或请求数量上限。");
      }
      budget.requests++;
      timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { "PRIVATE-TOKEN": token, Accept: "application/json, text/plain" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "暂时无法从配置的 GitLab 读取固定来源。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) {
        throw new DomainError(401, "AUTH_TOKEN_INVALID", "GitLab 授权已失效，请重新提交候选。");
      }
      throw new GitLabHttpError(response.status);
    }
    if (!response.body) throw new DomainError(502, "SOURCE_UNAVAILABLE", "GitLab 返回了空响应。");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DomainError(400, "VALIDATION_FAILED", "Manifest 或共享说明超过允许的大小上限。");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 来源读取中断，请稍后重试。");
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  private apiUrl(path: string): URL {
    return new URL(path, this.baseUrl);
  }
}

export function validateProjectId(value: string | number): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new DomainError(400, "VALIDATION_FAILED", "projectId 数值超出安全整数范围，请改用十进制字符串。");
  }
  const projectId = String(value);
  if (!/^[1-9]\d{0,19}$/.test(projectId)) {
    throw new DomainError(400, "VALIDATION_FAILED", "projectId 必须是有效的 GitLab 项目数字 ID。");
  }
  return projectId;
}

function checkedProjectUrl(value: unknown, gitlabBase: URL): string {
  if (typeof value !== "string") throw new DomainError(502, "SOURCE_UNAVAILABLE", "GitLab 项目信息不完整。");
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.origin !== gitlabBase.origin) {
      throw new Error("outside host");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new DomainError(502, "SOURCE_UNAVAILABLE", "GitLab 项目地址不属于已配置的实例。");
  }
}

function digestFiles(files: Map<string, Uint8Array>): string {
  const digest = createHash("sha256");
  for (const [filePath, bytes] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(filePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(bytes.byteLength), "utf8");
    digest.update(":", "utf8");
    digest.update(bytes);
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

function isLfsPointer(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, 80));
  return prefix.startsWith("version https://git-lfs.github.com/spec/v1\n");
}

function validIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function isSupportedReleaseTag(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && normalizeProjectVersion(value) !== undefined;
}
