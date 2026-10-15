import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const MANAGED_GITLAB_TOKEN = "fixture-server-side-gitlab-token";

interface Commit {
  id: string;
  message: string;
  files: Map<string, Uint8Array>;
}

interface Project {
  id: number;
  name: string;
  path: string;
  namespace: { id: number; full_path: string };
  visibility: string;
  builds_access_level: string;
  shared_runners_enabled: boolean;
  initialize_with_readme: boolean;
  created_at: string;
  web_url: string;
  default_branch: string | null;
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  tags: Map<string, string>;
  releases: Map<string, string>;
}

export interface ManagedGitLabFixture {
  url: string;
  state: {
    projects: Map<number, Project>;
    requests: Array<{ method: string; path: string }>;
    writes: Array<{ method: string; path: string }>;
    dropNextCommitResponse: boolean;
    dropCommitResponseOnNumber: number | null;
    commitCreateCount: number;
    rejectNextCommitStatus: number | null;
    failCommitReadback: boolean;
    nextProjectId: number;
    preseedTag(projectId: number, tag: string, sha: string): void;
  };
  close(): Promise<void>;
}

export async function startManagedGitLabFixture(initialDefaultBranch: string | null = null): Promise<ManagedGitLabFixture> {
  const projects = new Map<number, Project>();
  const requests: Array<{ method: string; path: string }> = [];
  const writes: Array<{ method: string; path: string }> = [];
  const state = {
    projects,
    requests,
    writes,
    dropNextCommitResponse: false,
    dropCommitResponseOnNumber: null,
    commitCreateCount: 0,
    rejectNextCommitStatus: null as number | null,
    failCommitReadback: false,
    nextProjectId: 100,
    preseedTag(projectId: number, tag: string, sha: string) {
      const project = projects.get(projectId);
      if (!project) throw new Error("Fixture project does not exist.");
      project.tags.set(tag, sha);
    },
  };

  let failNextBranchRead = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const method = request.method ?? "GET";
    requests.push({ method, path: `${url.pathname}${url.search}` });
    if (method !== "GET") writes.push({ method, path: url.pathname });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const fail = (status: number, error: string) => send(status, { error });
    if (request.headers["private-token"] !== MANAGED_GITLAB_TOKEN) return fail(401, "invalid fixture authorization");

    let body: Record<string, unknown> = {};
    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
      catch { return fail(400, "invalid JSON"); }
    }

    if (url.pathname === "/api/v4/user" && method === "GET") return send(200, { id: 35, username: "fixture-owner", name: "测试发布账号" });

    if (url.pathname === "/api/v4/projects" && method === "POST") {
      if ([...projects.values()].some(project => project.namespace.id === Number(body.namespace_id)
        && (project.name === String(body.name) || project.path === String(body.path)))) {
        return fail(400, "project name or path has already been taken in this namespace");
      }
      const project = newProject(state.nextProjectId++, body, request.headers.host ?? "127.0.0.1", initialDefaultBranch);
      projects.set(project.id, project);
      return send(201, projectJson(project));
    }

    const groupMatch = url.pathname.match(/^\/api\/v4\/groups\/(\d+)\/projects$/);
    if (groupMatch && method === "GET") {
      const groupId = Number(groupMatch[1]);
      const search = url.searchParams.get("search") ?? "";
      return send(200, [...projects.values()]
        .filter(project => project.namespace.id === groupId && project.path.includes(search))
        .map(projectJson));
    }

    const match = url.pathname.match(/^\/api\/v4\/projects\/(\d+)(.*)$/);
    if (!match) return fail(404, "not found");
    const project = projects.get(Number(match[1]));
    if (!project) return fail(404, "project not found");
    const suffix = match[2] ?? "";
    if (!suffix && method === "GET") return send(200, projectJson(project));

    if (suffix === "/repository/commits" && method === "POST") {
      state.commitCreateCount++;
      if (state.rejectNextCommitStatus) {
        const status = state.rejectNextCommitStatus;
        state.rejectNextCommitStatus = null;
        failNextBranchRead = state.failCommitReadback;
        state.failCommitReadback = false;
        return fail(status, "fixture rejection with a secret that must never be exposed");
      }
      const branch = String(body.branch ?? "");
      const message = String(body.commit_message ?? "");
      const actions = Array.isArray(body.actions) ? body.actions as Array<Record<string, unknown>> : [];
      if (!branch || !message || actions.length < 1 || actions.length > 100) return fail(400, "invalid commit action set");
      // GitLab defaults start_branch to branch when start_sha is absent. Only
      // an empty repository can create a new branch without an existing ref.
      if (!project.branches.has(branch) && project.commits.size > 0 && typeof body.start_sha !== "string") {
        return fail(400, "You can only create or edit files when you are on a branch");
      }
      const currentSha = project.branches.get(branch) ?? (typeof body.start_sha === "string" ? body.start_sha : undefined);
      const current = currentSha ? project.commits.get(currentSha) : undefined;
      if (currentSha && !current) return fail(400, "unknown start sha");
      const files = new Map(current?.files ?? []);
      for (const action of actions) {
        const filePath = String(action.file_path ?? "");
        if (!filePath || filePath.startsWith("/") || filePath.split("/").includes("..")) return fail(400, "invalid path");
        const previous = files.has(filePath);
        if (action.action === "create" && previous) return fail(400, "file exists");
        if (action.action === "update" && !previous) return fail(400, "file does not exist");
        if (action.action === "delete" && !previous) return fail(400, "file does not exist");
        if (action.action === "delete") files.delete(filePath);
        else if (["create", "update"].includes(String(action.action)) && action.encoding === "base64" && typeof action.content === "string") {
          files.set(filePath, new Uint8Array(Buffer.from(action.content, "base64")));
        } else return fail(400, "invalid action");
      }
      const id = createHash("sha1").update(`${project.id}\0${branch}\0${message}\0${JSON.stringify(actions)}\0${project.commits.size}`).digest("hex");
      project.commits.set(id, { id, message, files });
      project.branches.set(branch, id);
      if (!project.default_branch) project.default_branch = branch;
      if (state.failCommitReadback) {
        failNextBranchRead = true;
        state.failCommitReadback = false;
      }
      if (state.dropNextCommitResponse || state.dropCommitResponseOnNumber === state.commitCreateCount) {
        state.dropNextCommitResponse = false;
        state.dropCommitResponseOnNumber = null;
        response.destroy();
        return;
      }
      return send(201, { id, message });
    }

    const branchMatch = suffix.match(/^\/repository\/branches\/(.+)$/);
    if (branchMatch && method === "GET") {
      if (failNextBranchRead) {
        failNextBranchRead = false;
        return fail(503, "fixture readback unavailable");
      }
      const branch = decodeURIComponent(branchMatch[1]!);
      const sha = project.branches.get(branch);
      return sha ? send(200, { name: branch, commit: { id: sha } }) : fail(404, "branch not found");
    }

    const commitMatch = suffix.match(/^\/repository\/commits\/([^/]+)$/);
    if (commitMatch && method === "GET") {
      const sha = decodeURIComponent(commitMatch[1]!);
      const commit = project.commits.get(sha);
      return commit ? send(200, { id: commit.id, message: commit.message, created_at: "2026-10-13T00:00:00Z" }) : fail(404, "commit not found");
    }

    if (suffix === "/repository/tree" && method === "GET") {
      const ref = url.searchParams.get("ref") ?? "";
      const sha = project.branches.get(ref) ?? project.tags.get(ref) ?? ref;
      const commit = project.commits.get(sha);
      if (!commit) return fail(404, "tree not found");
      const parent = url.searchParams.get("path") ?? "";
      const prefix = parent ? `${parent}/` : "";
      const recursive = url.searchParams.get("recursive") === "true";
      const entries: Array<Record<string, string>> = [];
      const directories = new Set<string>();
      for (const [filePath, bytes] of commit.files) {
        if (!filePath.startsWith(prefix)) continue;
        const tail = filePath.slice(prefix.length);
        if (!recursive && tail.includes("/")) {
          directories.add(tail.split("/")[0]!);
          continue;
        }
        entries.push({ id: gitBlobId(bytes), name: filePath.split("/").at(-1)!, path: filePath, type: "blob", mode: "100644" });
      }
      for (const name of directories) entries.push({ id: "tree", name, path: prefix + name, type: "tree", mode: "040000" });
      entries.sort((left, right) => left.path!.localeCompare(right.path!));
      const perPage = Number(url.searchParams.get("per_page") ?? 100);
      const page = Number(url.searchParams.get("page") ?? 1);
      return send(200, entries.slice((page - 1) * perPage, page * perPage));
    }

    const rawMatch = suffix.match(/^\/repository\/files\/(.+)\/raw$/);
    if (rawMatch && method === "GET") {
      const filePath = decodeURIComponent(rawMatch[1]!);
      const ref = url.searchParams.get("ref") ?? "";
      const sha = project.branches.get(ref) ?? project.tags.get(ref) ?? ref;
      const bytes = project.commits.get(sha)?.files.get(filePath);
      if (!bytes) return fail(404, "file not found");
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end(Buffer.from(bytes));
    }

    const tagMatch = suffix.match(/^\/repository\/tags(?:\/(.+))?$/);
    if (tagMatch && method === "GET") {
      if (!tagMatch[1]) return send(200, [...project.tags.entries()].map(([name, sha]) => ({ name, commit: { id: sha } })));
      const tag = decodeURIComponent(tagMatch[1]);
      const sha = project.tags.get(tag);
      return sha ? send(200, { name: tag, commit: { id: sha } }) : fail(404, "tag not found");
    }
    if (suffix === "/repository/tags" && method === "POST") {
      const tag = String(body.tag_name ?? "");
      const sha = String(body.ref ?? "");
      if (!tag || !project.commits.has(sha)) return fail(400, "invalid tag ref");
      if (project.tags.has(tag)) return fail(409, "tag exists");
      project.tags.set(tag, sha);
      return send(201, { name: tag, commit: { id: sha } });
    }

    const releaseMatch = suffix.match(/^\/releases(?:\/(.+))?$/);
    if (releaseMatch && method === "GET") {
      if (!releaseMatch[1]) return send(200, [...project.releases.entries()].map(([tag, sha]) => releaseJson(tag, sha)));
      const tag = decodeURIComponent(releaseMatch[1]);
      const sha = project.releases.get(tag);
      return sha ? send(200, releaseJson(tag, sha)) : fail(404, "release not found");
    }
    if (suffix === "/releases" && method === "POST") {
      const tag = String(body.tag_name ?? "");
      const sha = project.tags.get(tag);
      if (!sha) return fail(400, "tag missing");
      if (project.releases.has(tag)) return fail(409, "release exists");
      project.releases.set(tag, sha);
      return send(201, releaseJson(tag, sha));
    }

    return fail(404, "not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function newProject(id: number, body: Record<string, unknown>, host: string, initialDefaultBranch: string | null): Project {
  const path = String(body.path ?? "");
  return {
    id,
    name: String(body.name ?? path),
    path,
    namespace: { id: Number(body.namespace_id), full_path: "sky-efficiency-skills/ai-apps" },
    visibility: String(body.visibility ?? "private"),
    builds_access_level: String(body.builds_access_level ?? "enabled"),
    shared_runners_enabled: body.shared_runners_enabled !== false,
    initialize_with_readme: body.initialize_with_readme === true,
    created_at: "2026-10-13T00:00:00Z",
    web_url: `http://${host}/sky-efficiency-skills/ai-apps/${path}`,
    default_branch: initialDefaultBranch,
    branches: new Map(),
    commits: new Map(),
    tags: new Map(),
    releases: new Map(),
  };
}

function projectJson(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    namespace: project.namespace,
    visibility: project.visibility,
    builds_access_level: project.builds_access_level,
    shared_runners_enabled: project.shared_runners_enabled,
    initialize_with_readme: project.initialize_with_readme,
    created_at: project.created_at,
    web_url: project.web_url,
    default_branch: project.default_branch,
    empty_repo: project.commits.size === 0,
    permissions: { project_access: { access_level: 50 }, group_access: null },
  };
}

function releaseJson(tag: string, sha: string): Record<string, unknown> {
  return { tag_name: tag, name: tag, commit: { id: sha } };
}

function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex");
}
