import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DomainError } from "./errors.js";
import type { Database } from "./database.js";
import type { PlazaService, SubmitResult } from "./service.js";
import { compareProjectVersions, decodeUtf8, manifestJson, normalizeProjectVersion, validateRepoPath } from "./manifest.js";

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_COMMIT_ACTIONS = 100;
const API_TIMEOUT_MS = 30_000;
const API_RESPONSE_BYTES = 8 * 1024 * 1024;

interface BindingRecord {
  id: string;
  app_key: string;
  publish_key_digest: string;
  project_id: string | null;
  public_app_id: string | null;
}

interface OperationRecord {
  id: string;
  binding_id: string;
  idempotency_digest: string;
  request_digest: string;
  manifest_path: string;
  expected_app_revision: number | null;
  base_commit_sha: string | null;
  project_id: string | null;
  branch: string;
  commit_sha: string | null;
  tag: string;
  status: "prepared" | "project_ready" | "commit_ready" | "tag_ready" | "release_ready" | "submitted";
}

interface GitLabProject {
  id?: string | number;
  name?: string;
  path?: string;
  web_url?: string;
  created_at?: string;
  visibility?: string;
  namespace?: { id?: string | number; full_path?: string };
  builds_access_level?: string;
  shared_runners_enabled?: boolean;
  default_branch?: string | null;
  empty_repo?: boolean;
  permissions?: {
    project_access?: { access_level?: number } | null;
    group_access?: { access_level?: number } | null;
  };
}

interface TreeEntry {
  id?: string;
  name?: string;
  path?: string;
  type?: string;
  mode?: string;
}

interface GitLabCommit {
  id?: string;
  message?: string;
}

interface GitLabTag {
  name?: string;
  commit?: { id?: string };
}

interface GitLabRelease {
  tag_name?: string;
  commit?: { id?: string };
}

interface InputFile {
  path: string;
  content: string;
}

interface ValidatedBundle {
  appKey: string;
  manifestPath: string;
  files: Map<string, Uint8Array>;
  manifest: ReturnType<typeof manifestJson>;
  requestDigest: string;
}

interface ManagedPublisherConfig {
  db: Database;
  gitlabUrl: string;
  gitlabToken: string;
  groupId: string;
  secret: string;
  service: PlazaService;
}

export interface ManagedSubmitInput {
  appKey: string;
  manifestPath: string;
  files: InputFile[];
  managedAppId?: string;
  expectedAppRevision?: number;
}

export interface ManagedPublisher {
  submit(
    input: ManagedSubmitInput,
    publishKey: string,
    idempotencyKey: string,
  ): Promise<SubmitResult & { managedAppId: string; sourceUploaded: true }>;
  current(managedAppId: string, publishKey: string): Promise<{
    managedAppId: string;
    appKey: string;
    projectId?: string;
    appId?: string;
    revision: number;
    version?: string;
  }>;
  findByAppId(appId: string): Promise<{ managedAppId: string; projectId: string; appKey: string } | undefined>;
}

class GitLabApiError extends Error {
  constructor(readonly status: number) {
    super("GitLab API request failed.");
  }
}

interface GitAction {
  action: "create" | "update" | "delete";
  file_path: string;
  encoding?: "base64";
  content?: string;
}

interface TreeValue {
  blobId: string;
  mode: string;
}

export function createManagedPublisher(config: ManagedPublisherConfig): ManagedPublisher {
  const secret = Buffer.from(config.secret, "utf8");
  if (secret.byteLength < 32) throw new Error("Managed publisher secret must be at least 32 bytes.");
  if (!/^[1-9]\d{0,19}$/.test(config.groupId) || !Number.isSafeInteger(Number(config.groupId))) {
    throw new Error("A numeric GitLab namespace id is required.");
  }
  if (typeof config.gitlabToken !== "string" || !config.gitlabToken || /[\r\n\u0000]/.test(config.gitlabToken)) {
    throw new Error("A server-side GitLab token is required.");
  }
  const groupId = config.groupId;
  const groupIdNumber = Number(groupId);
  const api = new GitLabWriter(config.gitlabUrl, config.gitlabToken);
  const instanceId = gitlabInstanceId(config.gitlabUrl);
  const locks = new Map<string, Promise<void>>();

  async function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    locks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  }

  function keyDigest(publishKey: string): string {
    return createHmac("sha256", secret).update("managed-publish-key-v1\0").update(publishKey).digest("hex");
  }

  function idempotencyDigest(bindingId: string, value: string): string {
    return createHmac("sha256", secret).update(`managed-idempotency-v1\0${bindingId}\0`).update(value).digest("hex");
  }

  async function loadOwnedBinding(input: ManagedSubmitInput, keyHash: string): Promise<{ binding: BindingRecord; isNew: boolean }> {
    if (input.managedAppId !== undefined) {
      if (!isUuid(input.managedAppId)) throw ownerError();
      const result = await config.db.query<BindingRecord>("SELECT * FROM managed_app_bindings WHERE id = $1", [input.managedAppId]);
      const binding = result.rows[0];
      if (!binding || !constantEqual(binding.publish_key_digest, keyHash) || binding.app_key !== input.appKey) throw ownerError();
      return { binding, isNew: false };
    }

    const found = (await config.db.query<BindingRecord>(
      "SELECT * FROM managed_app_bindings WHERE publish_key_digest = $1",
      [keyHash],
    )).rows[0];
    if (found) {
      if (found.app_key !== input.appKey) throw ownerError();
      return { binding: found, isNew: false };
    }

    const id = randomUUID();
    const now = new Date();
    const inserted = await config.db.query<BindingRecord>(
      `INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) ON CONFLICT (publish_key_digest) DO NOTHING RETURNING *`,
      [id, input.appKey, keyHash, now],
    );
    if (inserted.rows[0]) return { binding: inserted.rows[0], isNew: true };
    const raced = (await config.db.query<BindingRecord>(
      "SELECT * FROM managed_app_bindings WHERE publish_key_digest = $1",
      [keyHash],
    )).rows[0];
    if (!raced || raced.app_key !== input.appKey) throw ownerError();
    return { binding: raced, isNew: false };
  }

  async function findOperation(bindingId: string, digest: string): Promise<OperationRecord | undefined> {
    return (await config.db.query<OperationRecord>(
      "SELECT * FROM managed_publish_operations WHERE binding_id = $1 AND idempotency_digest = $2",
      [bindingId, digest],
    )).rows[0];
  }

  async function updateOperation(operation: OperationRecord, fields: Partial<Pick<OperationRecord, "project_id" | "base_commit_sha" | "commit_sha" | "status">>): Promise<OperationRecord> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return operation;
    const assignments = entries.map(([column], index) => `${column} = $${index + 2}`).join(", ");
    const params = [operation.id, ...entries.map(([, value]) => value), new Date()];
    const result = await config.db.query<OperationRecord>(
      `UPDATE managed_publish_operations SET ${assignments}, updated_at = $${params.length} WHERE id = $1 RETURNING *`,
      params,
    );
    return result.rows[0] ?? operation;
  }

  async function updateBindingProject(binding: BindingRecord, projectId: string): Promise<BindingRecord> {
    const result = await config.db.query<BindingRecord>(
      "UPDATE managed_app_bindings SET project_id = COALESCE(project_id, $2), updated_at = $3 WHERE id = $1 RETURNING *",
      [binding.id, projectId, new Date()],
    );
    const updated = result.rows[0];
    if (!updated || updated.project_id !== projectId) throw stateConflict();
    return updated;
  }

  async function updateBindingApp(binding: BindingRecord, appId: string | undefined): Promise<BindingRecord> {
    // This column is only the first seen candidate id. Pending candidates can
    // have different ids; catalog_apps is the authority after confirmation.
    if (!appId || binding.public_app_id) return binding;
    const result = await config.db.query<BindingRecord>(
      "UPDATE managed_app_bindings SET public_app_id = COALESCE(public_app_id, $2), updated_at = $3 WHERE id = $1 RETURNING *",
      [binding.id, appId, new Date()],
    );
    return result.rows[0] ?? binding;
  }

  async function ensureUpdateOwnership(
    binding: BindingRecord,
    input: ManagedSubmitInput,
    bundle: ValidatedBundle,
  ): Promise<string | null> {
    if (input.managedAppId === undefined) {
      if (input.expectedAppRevision !== undefined) throw ownerError();
      return null;
    }
    if (!binding.project_id) throw ownerError();
    if (!Number.isInteger(input.expectedAppRevision) || input.expectedAppRevision! < 0) {
      throw new DomainError(400, "VALIDATION_FAILED", "更新必须提供当前应用 revision；首次预览的后续修订使用 revision 0。");
    }
    const catalogAppId = await findCatalogAppId(binding);
    if (!catalogAppId) {
      if (input.expectedAppRevision === 0) return null;
      throw new DomainError(409, "REVISION_CONFLICT", "该应用尚未收录。请使用 revision 0 修订首次预览。");
    }
    if (input.expectedAppRevision === 0) {
      throw new DomainError(409, "REVISION_CONFLICT", "应用已收录，请读取当前 revision 后再提交更新。");
    }
    let app;
    try {
      app = await config.service.app(catalogAppId);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "暂时无法读取广场应用状态，请稍后用相同幂等键重试。");
    }
    if (app.source.projectId !== binding.project_id || app.manifest.appKey !== binding.app_key) {
      throw ownerError();
    }
    if (app.revision !== input.expectedAppRevision) {
      throw new DomainError(409, "REVISION_CONFLICT", "广场应用已更新。请重新读取当前 revision 和版本，再生成新的上传请求。");
    }
    const difference = compareProjectVersions(bundle.manifest.projectVersion, app.version);
    if (difference === undefined || difference <= 0) {
      throw new DomainError(409, "VERSION_NOT_NEWER", "更新版本必须高于广场当前版本，请准备新的 projectVersion 后重新提交。");
    }
    return app.source.commitSha;
  }

  async function findCatalogAppId(binding: BindingRecord): Promise<string | undefined> {
    if (!binding.project_id) return undefined;
    const result = await config.db.query<{ id: string }>(
      `SELECT app.id
         FROM catalog_apps AS app
        WHERE app.instance_id = $1 AND app.project_id = $2 AND app.app_key = $3`,
      [instanceId, binding.project_id, binding.app_key],
    );
    return result.rows[0]?.id;
  }

  async function createOperation(
    binding: BindingRecord,
    input: ManagedSubmitInput,
    bundle: ValidatedBundle,
    idemDigest: string,
    baseCommitSha: string | null,
  ): Promise<OperationRecord> {
    const id = randomUUID();
    const tag = `v${normalizeProjectVersion(bundle.manifest.projectVersion)!}`;
    const branch = `plaza-upload-${id}`;
    const now = new Date();
    const inserted = await config.db.query<OperationRecord>(
      `INSERT INTO managed_publish_operations (
         id, binding_id, idempotency_digest, request_digest, manifest_path,
         expected_app_revision, base_commit_sha, branch, tag, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'prepared', $10, $10)
       ON CONFLICT (binding_id, idempotency_digest) DO NOTHING RETURNING *`,
      [id, binding.id, idemDigest, bundle.requestDigest, bundle.manifestPath, input.expectedAppRevision ?? null, baseCommitSha, branch, tag, now],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const raced = await findOperation(binding.id, idemDigest);
    if (!raced) throw stateConflict();
    if (raced.request_digest !== bundle.requestDigest) throw idempotencyConflict();
    return raced;
  }

  async function ensureVersionIsNewForBinding(binding: BindingRecord, bundle: ValidatedBundle): Promise<void> {
    const rows = await config.db.query<{ tag: string }>(
      "SELECT tag FROM managed_publish_operations WHERE binding_id = $1",
      [binding.id],
    );
    const candidate = normalizeProjectVersion(bundle.manifest.projectVersion)!;
    if (rows.rows.some(({ tag }) => {
      const previous = normalizeProjectVersion(tag);
      return previous !== undefined && compareProjectVersions(candidate, previous) !== 1;
    })) {
      throw new DomainError(409, "VERSION_NOT_NEWER", "同一托管应用的新预览必须使用高于此前候选的 projectVersion；GitLab tag 和 Release 不会移动或覆盖。");
    }
  }

  async function ensureProject(binding: BindingRecord): Promise<GitLabProject> {
    if (binding.project_id) {
      const project = await api.getProject(binding.project_id);
      assertManagedProject(project, groupId);
      return project;
    }
    const path = `${binding.app_key}-${binding.id.replaceAll("-", "").slice(0, 16)}`;
    let project = await api.findManagedProject(groupId, path);
    if (!project) {
      try {
        project = await api.createProject({
          name: `${binding.app_key} · AI 应用广场`,
          path,
          namespace_id: groupIdNumber,
          visibility: "private",
          initialize_with_readme: false,
          builds_access_level: "disabled",
          shared_runners_enabled: false,
        });
      } catch {
        // A lost POST response is resolved by the deterministic namespace/path pair.
        project = await api.findManagedProject(groupId, path).catch(() => undefined);
        if (!project) throw gitlabUnavailable();
      }
    }
    assertManagedProject(project, groupId);
    return project;
  }

  async function processOperation(
    bindingInput: BindingRecord,
    operationInput: OperationRecord,
    bundle: ValidatedBundle,
  ): Promise<SubmitResult & { managedAppId: string; sourceUploaded: true }> {
    let binding = bindingInput;
    let operation = operationInput;
    let project: GitLabProject;
    try {
      project = await ensureProject(binding);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw gitlabUnavailable();
    }
    const projectId = requireProjectId(project.id);
    binding = await updateBindingProject(binding, projectId);
    operation = await updateOperation(operation, { project_id: projectId, status: "project_ready" });

    const commitSha = await ensureCommits(projectId, operation, bundle, project);
    operation = await updateOperation(operation, { commit_sha: commitSha, status: "commit_ready" });
    await ensureTag(projectId, operation.tag, commitSha);
    operation = await updateOperation(operation, { status: "tag_ready" });
    await ensureRelease(projectId, operation.tag, commitSha, operation.id, operation.request_digest);
    operation = await updateOperation(operation, { status: "release_ready" });

    let result: SubmitResult;
    try {
      result = await config.service.submit({
        projectId,
        appKey: bundle.appKey,
        manifestPath: bundle.manifestPath,
        commitSha,
        tag: operation.tag,
        ...(operation.expected_app_revision === null ? {} : { expectedAppRevision: operation.expected_app_revision }),
      }, config.gitlabToken, `managed:${operation.id}`);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, "PUBLICATION_FAILED", "源码已上传至 GitLab，但广场预览暂时不可用。请使用相同幂等键重试。");
    }
    const appId = result.preview?.id ?? result.appId;
    binding = await updateBindingApp(binding, appId);
    operation = await updateOperation(operation, { status: "submitted" });
    return { ...result, managedAppId: binding.id, sourceUploaded: true };
  }

  async function ensureCommits(projectId: string, operation: OperationRecord, bundle: ValidatedBundle, project: GitLabProject): Promise<string> {
    const branchHead = await api.getBranch(projectId, operation.branch);
    if (!branchHead && operation.commit_sha) {
      throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "已记录的托管上传分支无法读取，已停止重复创建源码。");
    }
    // Revision 0 means no confirmed catalog entry, not an empty Git repository.
    // Repair old project_ready operations too, before any new commit is posted.
    // An existing branch must retain its original base for batch recovery.
    if (!branchHead && !operation.base_commit_sha && (project.empty_repo === false || project.default_branch)) {
      const previous = await config.db.query<OperationRecord>(
        `SELECT * FROM managed_publish_operations
          WHERE binding_id = $1 AND project_id = $2 AND id <> $3 AND commit_sha IS NOT NULL
          ORDER BY created_at DESC, id DESC`,
        [operation.binding_id, projectId, operation.id],
      );
      let baseSha: string | undefined;
      for (const candidate of previous.rows) {
        let commit: GitLabCommit;
        try { commit = await api.getCommit(projectId, candidate.commit_sha!); }
        catch (error) {
          if (error instanceof GitLabApiError && error.status === 404) {
            throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "此前记录的托管提交无法读取，已停止创建修订分支。");
          }
          throw gitlabUnavailable();
        }
        const marker = parseCommitMarker(commit.message ?? "");
        if (commit.id?.toLowerCase() !== candidate.commit_sha || !marker ||
            marker.operationId !== candidate.id || marker.requestDigest !== candidate.request_digest ||
            marker.batch < 1 || marker.batch > marker.total) {
          throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "此前托管提交与应用记录不一致，已停止创建修订分支。");
        }
        if (marker.batch === marker.total) {
          baseSha = candidate.commit_sha!;
          break;
        }
      }
      if (!baseSha) {
        throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "已有 GitLab 仓库缺少可核验的完整托管提交，已停止创建修订分支。");
      }
      // Freeze the base before POST, including an interruption before the first
      // commit. Concurrent retries must use the same persisted SHA.
      const saved = await config.db.query<OperationRecord>(
        `UPDATE managed_publish_operations
            SET base_commit_sha = COALESCE(base_commit_sha, $2), updated_at = $3
          WHERE id = $1 AND commit_sha IS NULL RETURNING *`,
        [operation.id, baseSha, new Date()],
      );
      if (!saved.rows[0]?.base_commit_sha) throw stateConflict();
      operation = saved.rows[0];
    }
    const baseEntries = operation.base_commit_sha
      ? await api.getTree(projectId, operation.base_commit_sha)
      : new Map<string, TreeValue>();
    const actions = buildActions(baseEntries, bundle.files);
    if (actions.length === 0) {
      if (!operation.base_commit_sha) throw stateConflict();
      return operation.base_commit_sha;
    }
    const batches: GitAction[][] = [];
    for (let index = 0; index < actions.length; index += MAX_COMMIT_ACTIONS) {
      batches.push(actions.slice(index, index + MAX_COMMIT_ACTIONS));
    }
    let expected = new Map(baseEntries);

    let completed = 0;
    if (branchHead) {
      const commit = await api.getCommit(projectId, branchHead);
      const marker = parseCommitMarker(commit.message ?? "");
      if (!marker || marker.operationId !== operation.id || marker.requestDigest !== operation.request_digest || marker.total !== batches.length) {
        throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "托管上传分支与本次请求不一致，已停止以保护已有 Git 历史。");
      }
      if (marker.batch < 1 || marker.batch > batches.length) throw stateConflict();
      for (let index = 0; index < marker.batch; index++) expected = applyActions(expected, batches[index]!);
      await api.assertTree(projectId, branchHead, expected);
      completed = marker.batch;
      await updateOperation(operation, { commit_sha: branchHead });
    }

    for (let index = completed; index < batches.length; index++) {
      const batch = index + 1;
      const batchActions = batches[index]!;
      const nextExpected = applyActions(expected, batchActions);
      const marker = `Operation-ID: ${operation.id}\nRequest-Digest: ${operation.request_digest}\nBatch: ${batch}/${batches.length}`;
      const commitMessage = `AI 应用广场托管上传\n\n${marker}`;
      const payload: Record<string, unknown> = {
        branch: operation.branch,
        commit_message: commitMessage,
        actions: batchActions,
      };
      if (batch === 1 && operation.base_commit_sha) payload.start_sha = operation.base_commit_sha;

      let postError: unknown;
      try {
        await api.createCommit(projectId, payload);
      } catch (error) {
        postError = error;
      }
      let recoveredHead: string | undefined;
      try { recoveredHead = await api.getBranch(projectId, operation.branch); }
      catch { throw gitlabUnavailable(); }
      if (!recoveredHead) {
        assertCommitNotRejected(postError);
        if (postError) throw gitlabUnavailable();
        throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 已接收源码但暂时无法核验提交。请使用相同幂等键重试。");
      }
      const recoveredCommit = await api.getCommit(projectId, recoveredHead);
      const recoveredMarker = parseCommitMarker(recoveredCommit.message ?? "");
      if (recoveredMarker?.operationId === operation.id && recoveredMarker.requestDigest === operation.request_digest && recoveredMarker.total === batches.length && recoveredMarker.batch === batch) {
        await api.assertTree(projectId, recoveredHead, nextExpected);
        expected = nextExpected;
        await updateOperation(operation, { commit_sha: recoveredHead });
        continue;
      }
      if (recoveredMarker?.operationId === operation.id && recoveredMarker.requestDigest === operation.request_digest && recoveredMarker.total === batches.length && recoveredMarker.batch === batch - 1) {
        await api.assertTree(projectId, recoveredHead, expected);
        assertCommitNotRejected(postError);
        // The request did not advance the branch. A same-key retry can safely post it again.
        throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 尚未确认本批源码提交。请使用相同幂等键重试。");
      }
      throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "GitLab 托管上传分支与本次提交不一致，已停止继续写入。");
    }
    const finalHead = await api.getBranch(projectId, operation.branch);
    if (!finalHead) throw gitlabUnavailable();
    await api.assertTree(projectId, finalHead, expected);
    return finalHead;
  }

  async function ensureTag(projectId: string, tag: string, commitSha: string): Promise<void> {
    const existing = await api.getTag(projectId, tag);
    if (existing) {
      if (existing.commit?.id?.toLowerCase() !== commitSha.toLowerCase()) throw tagConflict();
      return;
    }
    let postError: unknown;
    try {
      await api.createTag(projectId, tag, commitSha);
    } catch (error) {
      postError = error;
    }
    const recovered = await api.getTag(projectId, tag).catch(() => undefined);
    if (recovered?.commit?.id?.toLowerCase() === commitSha.toLowerCase()) return;
    if (recovered) throw tagConflict();
    if (postError) throw gitlabUnavailable();
    throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 暂未确认版本 tag。请使用相同幂等键重试。");
  }

  async function ensureRelease(projectId: string, tag: string, commitSha: string, operationId: string, requestDigest: string): Promise<void> {
    const existing = await api.getRelease(projectId, tag);
    if (existing) {
      if (existing.tag_name !== tag || existing.commit?.id?.toLowerCase() !== commitSha.toLowerCase()) throw releaseConflict();
      return;
    }
    let postError: unknown;
    try {
      await api.createRelease(projectId, {
        tag_name: tag,
        name: tag,
        description: `AI 应用广场托管上传\n\nOperation-ID: ${operationId}\nRequest-Digest: ${requestDigest}`,
      });
    } catch (error) {
      postError = error;
    }
    const recovered = await api.getRelease(projectId, tag).catch(() => undefined);
    if (recovered?.tag_name === tag && recovered.commit?.id?.toLowerCase() === commitSha.toLowerCase()) return;
    if (recovered) throw releaseConflict();
    if (postError) throw gitlabUnavailable();
    throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 暂未确认版本 Release。请使用相同幂等键重试。");
  }

  return {
    async submit(input, publishKey, idempotencyKey) {
      const bundle = validateBundle(input, config.gitlabToken);
      validatePublishKey(publishKey);
      validateIdempotencyKey(idempotencyKey);
      const keyHash = keyDigest(publishKey);
      return withKeyLock(keyHash, async () => {
        const loaded = await loadOwnedBinding(input, keyHash);
        const binding = loaded.binding;
        const idemDigest = idempotencyDigest(binding.id, idempotencyKey);
        let operation = await findOperation(binding.id, idemDigest);
        if (operation && operation.request_digest !== bundle.requestDigest) throw idempotencyConflict();
        if (operation && operation.expected_app_revision !== null && input.managedAppId !== binding.id) throw ownerError();

        if (!input.managedAppId && loaded.isNew === false && !operation && (binding.project_id || binding.public_app_id)) {
          throw ownerError();
        }

        if (!operation) {
          const baseCommitSha = await ensureUpdateOwnership(binding, input, bundle);
          if (loaded.isNew && (input.managedAppId !== undefined || input.expectedAppRevision !== undefined)) throw ownerError();
          await ensureVersionIsNewForBinding(binding, bundle);
          operation = await createOperation(binding, input, bundle, idemDigest, baseCommitSha);
        }
        return processOperation(binding, operation, bundle);
      });
    },

    async current(managedAppId, publishKey) {
      validatePublishKey(publishKey);
      if (!isUuid(managedAppId)) throw ownerError();
      const binding = (await config.db.query<BindingRecord>(
        "SELECT * FROM managed_app_bindings WHERE id = $1",
        [managedAppId],
      )).rows[0];
      if (!binding || !constantEqual(binding.publish_key_digest, keyDigest(publishKey))) throw ownerError();

      const base = {
        managedAppId: binding.id,
        appKey: binding.app_key,
        ...(binding.project_id ? { projectId: binding.project_id } : {}),
      };
      const catalogAppId = await findCatalogAppId(binding);
      if (!catalogAppId) return { ...base, revision: 0 };

      let app;
      try {
        app = await config.service.app(catalogAppId);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(503, "SOURCE_UNAVAILABLE", "暂时无法读取广场应用状态，请稍后重试。");
      }
      if (app.id !== catalogAppId || app.source.projectId !== binding.project_id || app.manifest.appKey !== binding.app_key) {
        throw stateConflict();
      }
      return { ...base, appId: app.id, revision: app.revision, version: app.version };
    },

    async findByAppId(appId) {
      if (!isUuid(appId)) return undefined;
      const binding = (await config.db.query<BindingRecord>(
        `SELECT binding.*
           FROM managed_app_bindings AS binding
           JOIN catalog_apps AS app
             ON app.project_id = binding.project_id AND app.app_key = binding.app_key
          WHERE app.id = $1 AND app.instance_id = $2`,
        [appId, instanceId],
      )).rows[0];
      if (!binding?.project_id) return undefined;
      return { managedAppId: binding.id, projectId: binding.project_id, appKey: binding.app_key };
    },
  };
}

function validateBundle(input: ManagedSubmitInput, serverGitLabToken: string): ValidatedBundle {
  if (!input || typeof input !== "object" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.appKey) || input.appKey.length > 64) {
    throw new DomainError(400, "VALIDATION_FAILED", "appKey 格式无效。");
  }
  const manifestPath = validateRepoPath(input.manifestPath, "Manifest 路径");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    throw new DomainError(400, "VALIDATION_FAILED", "源码文件数量必须在 1 到 1000 个之间。");
  }
  if (input.expectedAppRevision !== undefined && (!Number.isInteger(input.expectedAppRevision) || input.expectedAppRevision < 0)) {
    throw new DomainError(400, "VALIDATION_FAILED", "expectedAppRevision 必须是非负整数。");
  }
  const files = new Map<string, Uint8Array>();
  const canonicalPaths = new Map<string, string>();
  let total = 0;
  for (const entry of input.files) {
    if (!entry || typeof entry !== "object") throw new DomainError(400, "VALIDATION_FAILED", "源码文件格式无效。");
    const filePath = validateRepoPath(entry.path, "源码文件路径");
    if (typeof entry.content !== "string" || entry.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 || !isCanonicalBase64(entry.content)) {
      throw new DomainError(400, "VALIDATION_FAILED", "源码文件必须是有效的标准 Base64 内容。");
    }
    const bytes = Buffer.from(entry.content, "base64");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new DomainError(400, "VALIDATION_FAILED", "单个源码文件不能超过 5 MiB。");
    total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) throw new DomainError(400, "VALIDATION_FAILED", "源码总大小不能超过 20 MiB。");
    assertSafePath(filePath);
    const folded = filePath.normalize("NFKC").toLocaleLowerCase("en-US");
    if (canonicalPaths.has(folded)) throw new DomainError(400, "VALIDATION_FAILED", "源码中存在重复或大小写冲突的路径。");
    canonicalPaths.set(folded, filePath);
    files.set(filePath, new Uint8Array(bytes));
    if (containsSecretMarker(bytes, serverGitLabToken)) throw new DomainError(400, "VALIDATION_FAILED", "源码包含疑似访问凭据或私钥，请先移除后重新提交。");
  }
  for (const path of canonicalPaths.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const prefix = segments.slice(0, index).join("/").normalize("NFKC").toLocaleLowerCase("en-US");
      if (canonicalPaths.has(prefix)) throw new DomainError(400, "VALIDATION_FAILED", "源码路径存在文件与目录冲突。");
    }
  }
  const manifestBytes = files.get(manifestPath);
  if (!manifestBytes) throw new DomainError(400, "VALIDATION_FAILED", "完整源码包必须包含指定的 Manifest 文件。");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new DomainError(400, "VALIDATION_FAILED", "Manifest 不能超过 64 KiB。");
  const manifest = manifestJson(decodeUtf8(manifestBytes, "Manifest"), input.appKey);
  const documents = new Set([manifest.docs.readme, manifest.docs.usage]);
  for (const entry of manifest.entries) if (entry.kind === "agent") documents.add(entry.instructionsPath);
  let documentBytes = 0;
  for (const docPath of documents) {
    validateRepoPath(docPath, "共享说明路径");
    const bytes = files.get(docPath);
    if (!bytes) throw new DomainError(400, "VALIDATION_FAILED", "源码包必须包含 Manifest 声明的 README、使用说明和 Agent 接入说明。");
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DomainError(400, "VALIDATION_FAILED", "单份共享说明不能超过 512 KiB。");
    documentBytes += bytes.byteLength;
    if (documentBytes > MAX_DOCUMENT_BYTES) throw new DomainError(400, "VALIDATION_FAILED", "共享说明总大小不能超过 512 KiB。");
    const text = decodeUtf8(bytes, "共享说明");
    if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) throw new DomainError(400, "VALIDATION_FAILED", "共享说明不能是 Git LFS 指针文件。");
  }
  const digest = createHash("sha256");
  digest.update(JSON.stringify({ appKey: input.appKey, manifestPath, expectedAppRevision: input.expectedAppRevision ?? null }));
  for (const [filePath, bytes] of [...files.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    digest.update("\0");
    digest.update(filePath, "utf8");
    digest.update("\0");
    digest.update(String(bytes.byteLength), "utf8");
    digest.update(":");
    digest.update(bytes);
  }
  return { appKey: input.appKey, manifestPath, files, manifest, requestDigest: digest.digest("hex") };
}

function assertSafePath(filePath: string): void {
  const segments = filePath.normalize("NFKC").split("/").map((part) => part.toLocaleLowerCase("en-US"));
  const basename = segments.at(-1)!;
  const forbidden = segments.some((part) =>
    part === ".git" || part === ".worktrees" || part === "node_modules" || part === ".ssh" ||
    part === "credentials" || part === "credential" || part === "secrets" || part === "secret" ||
    part === ".aws" || part === ".azure" || part === ".kube" || part === ".mcp.json" ||
    part === ".npmrc" || part === ".pypirc" || part === ".envrc" ||
    part === ".env" || part.startsWith(".env."),
  ) || /\.(?:pem|p12|pfx|key)$/.test(basename) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(basename) ||
    /(?:^|[._-])credentials?(?:[._-]|$)/.test(basename) ||
    ["secrets.json", "auth.json"].includes(basename);
  if (forbidden) throw new DomainError(400, "VALIDATION_FAILED", "源码包包含禁止上传的凭据或本地配置路径。");
}

function containsSecretMarker(bytes: Uint8Array, serverGitLabToken: string): boolean {
  const text = Buffer.from(bytes).toString("utf8");
  return /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i.test(text) ||
    /\bgl(?:pat|rt|dt|cbt|soat)-[A-Za-z0-9_-]{12,}\b/i.test(text) ||
    /(?:PRIVATE-TOKEN|X-GitLab-Token|GITLAB_(?:ACCESS_)?TOKEN)\s*[:=]\s*[^\s"']{8,}/i.test(text) ||
    (serverGitLabToken.length >= 8 && text.includes(serverGitLabToken));
}

function buildActions(previous: Map<string, TreeValue>, files: Map<string, Uint8Array>): GitAction[] {
  const actions: GitAction[] = [];
  for (const [filePath, oldValue] of previous) {
    if (!files.has(filePath)) actions.push({ action: "delete", file_path: filePath });
    else {
      const next = files.get(filePath)!;
      const blobId = gitBlobId(next);
      if (blobId !== oldValue.blobId || oldValue.mode !== "100644") {
        actions.push({ action: "update", file_path: filePath, encoding: "base64", content: Buffer.from(next).toString("base64") });
      }
    }
  }
  for (const [filePath, bytes] of files) {
    if (!previous.has(filePath)) actions.push({ action: "create", file_path: filePath, encoding: "base64", content: Buffer.from(bytes).toString("base64") });
  }
  return actions.sort((left, right) => compareStrings(left.file_path, right.file_path));
}

function applyActions(previous: Map<string, TreeValue>, actions: GitAction[]): Map<string, TreeValue> {
  const next = new Map(previous);
  for (const action of actions) {
    if (action.action === "delete") next.delete(action.file_path);
    else next.set(action.file_path, { blobId: gitBlobId(Buffer.from(action.content!, "base64")), mode: "100644" });
  }
  return next;
}

function gitBlobId(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCommitMarker(message: string): { operationId: string; requestDigest: string; batch: number; total: number } | undefined {
  const operationId = message.match(/(?:^|\n)Operation-ID: ([0-9a-f-]{36})(?:\n|$)/i)?.[1];
  const requestDigest = message.match(/(?:^|\n)Request-Digest: ([a-f0-9]{64})(?:\n|$)/i)?.[1];
  const batch = message.match(/(?:^|\n)Batch: (\d+)\/(\d+)(?:\n|$)/)?.slice(1).map(Number);
  if (!operationId || !requestDigest || !batch || !Number.isInteger(batch[0]) || !Number.isInteger(batch[1])) return undefined;
  return { operationId, requestDigest, batch: batch[0]!, total: batch[1]! };
}

class GitLabWriter {
  private readonly baseUrl: URL;

  constructor(gitlabUrl: string, private readonly token: string) {
    let parsed: URL;
    try { parsed = new URL(gitlabUrl); } catch { throw new Error("A valid GitLab URL is required."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("GitLab URL must use HTTP(S) and must not contain credentials or query data.");
    }
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
    this.baseUrl = parsed;
  }

  async findManagedProject(groupId: string, path: string): Promise<GitLabProject | undefined> {
    const url = this.url(`api/v4/groups/${encodeURIComponent(groupId)}/projects`);
    url.searchParams.set("search", path);
    url.searchParams.set("include_subgroups", "false");
    url.searchParams.set("per_page", "100");
    const values = await this.request<GitLabProject[]>(url);
    const exact = values.find((project) => project.path === path && String(project.namespace?.id ?? "") === groupId);
    return exact;
  }

  async createProject(body: Record<string, unknown>): Promise<GitLabProject> {
    return this.request("api/v4/projects", { method: "POST", body });
  }

  async getProject(projectId: string): Promise<GitLabProject> {
    try { return await this.request(`api/v4/projects/${encodeURIComponent(projectId)}`); }
    catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "已绑定的 GitLab 项目不可读取，已停止创建替代项目。");
      throw error;
    }
  }

  async getBranch(projectId: string, branch: string): Promise<string | undefined> {
    try {
      const value = await this.request<{ commit?: { id?: string } }>(`api/v4/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`);
      if (!isSha(value.commit?.id)) throw gitlabUnavailable();
      return value.commit!.id!.toLowerCase();
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async getCommit(projectId: string, sha: string): Promise<GitLabCommit> {
    return this.request(`api/v4/projects/${projectId}/repository/commits/${encodeURIComponent(sha)}`);
  }

  async getTree(projectId: string, ref: string): Promise<Map<string, TreeValue>> {
    const result = new Map<string, TreeValue>();
    for (let page = 1; page <= 20; page++) {
      const url = this.url(`api/v4/projects/${projectId}/repository/tree`);
      url.searchParams.set("ref", ref);
      url.searchParams.set("recursive", "true");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const entries = await this.request<TreeEntry[]>(url);
      for (const entry of entries) {
        if (entry.type === "tree") continue;
        if (entry.type !== "blob" || !entry.path || !isSha(entry.id) || !["100644", "100755"].includes(entry.mode ?? "")) {
          throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "已发布 GitLab 树包含非普通文件，已停止覆盖。");
        }
        if (result.has(entry.path)) throw gitlabUnavailable();
        result.set(entry.path, { blobId: entry.id.toLowerCase(), mode: entry.mode! });
        if (result.size > MAX_FILES) throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "已绑定 GitLab 项目的文件数超出托管上限，已停止更新。");
      }
      if (entries.length < 100) return result;
    }
    throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "已绑定 GitLab 项目的目录树超出托管读取上限，已停止更新。");
  }

  async assertTree(projectId: string, sha: string, expected: Map<string, TreeValue>): Promise<void> {
    const actual = await this.getTree(projectId, sha);
    if (actual.size !== expected.size) throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "GitLab 提交内容与本次上传不一致，已停止继续写入。");
    for (const [filePath, wanted] of expected) {
      const found = actual.get(filePath);
      if (!found || found.blobId !== wanted.blobId || found.mode !== wanted.mode) {
        throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "GitLab 提交内容与本次上传不一致，已停止继续写入。");
      }
    }
  }

  async createCommit(projectId: string, body: Record<string, unknown>): Promise<GitLabCommit> {
    return this.request(`api/v4/projects/${projectId}/repository/commits`, { method: "POST", body });
  }

  async getTag(projectId: string, tag: string): Promise<GitLabTag | undefined> {
    try { return await this.request(`api/v4/projects/${projectId}/repository/tags/${encodeURIComponent(tag)}`); }
    catch (error) { if (error instanceof GitLabApiError && error.status === 404) return undefined; throw error; }
  }

  async createTag(projectId: string, tag: string, sha: string): Promise<void> {
    await this.request(`api/v4/projects/${projectId}/repository/tags`, { method: "POST", body: { tag_name: tag, ref: sha } });
  }

  async getRelease(projectId: string, tag: string): Promise<GitLabRelease | undefined> {
    try { return await this.request(`api/v4/projects/${projectId}/releases/${encodeURIComponent(tag)}`); }
    catch (error) { if (error instanceof GitLabApiError && error.status === 404) return undefined; throw error; }
  }

  async createRelease(projectId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`api/v4/projects/${projectId}/releases`, { method: "POST", body });
  }

  private url(path: string): URL { return new URL(path, this.baseUrl); }

  private async request<T = Record<string, unknown>>(
    pathOrUrl: string | URL,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    const url = typeof pathOrUrl === "string" ? this.url(pathOrUrl) : pathOrUrl;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "暂时无法连接配置的 GitLab，请使用相同幂等键重试。");
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      throw new GitLabApiError(status);
    }
    if (!response.body) throw gitlabUnavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > API_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw gitlabUnavailable();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "GitLab 响应读取中断，请使用相同幂等键重试。");
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
    if (bytes.byteLength === 0) return undefined as T;
    try { return JSON.parse(bytes.toString("utf8")) as T; }
    catch { throw gitlabUnavailable(); }
  }
}

function assertManagedProject(project: GitLabProject, groupId: string): void {
  requireProjectId(project.id);
  if (String(project.namespace?.id ?? "") !== groupId || project.visibility !== "private" ||
      project.builds_access_level !== "disabled" || project.shared_runners_enabled !== false) {
    throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", "GitLab 项目不在固定私有命名空间，或 CI 未关闭，已停止写入。");
  }
}

function assertCommitNotRejected(error: unknown): void {
  if (error instanceof GitLabApiError && [400, 409, 422].includes(error.status)) {
    throw new DomainError(409, "MANAGED_SOURCE_CONFLICT", `GitLab 拒绝本批源码提交（HTTP ${error.status}），且回读未发现提交成功。请核对托管源码状态后重试。`);
  }
}

function requireProjectId(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d{0,19}$/.test(String(value))) throw gitlabUnavailable();
  return String(value);
}

function validatePublishKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw ownerError();
  let bytes: Buffer;
  try { bytes = Buffer.from(value, "base64url"); } catch { throw ownerError(); }
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) throw ownerError();
}

function validateIdempotencyKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(value)) {
    throw new DomainError(400, "VALIDATION_FAILED", "Idempotency-Key 格式无效；网络重试必须复用同一个值。");
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function isUuid(value: string): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function gitlabInstanceId(value: string): string {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString().replace(/\/$/, "");
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function ownerError(): DomainError {
  return new DomainError(403, "MANAGED_APP_OWNER_REQUIRED", "应用专属发布凭证无效或不匹配；更新必须使用首次发布返回的 managedAppId 和发布凭证。");
}

function idempotencyConflict(): DomainError {
  return new DomainError(409, "IDEMPOTENCY_CONFLICT", "相同幂等键已用于不同源码内容；请为新提交生成新的幂等键。");
}

function tagConflict(): DomainError {
  return new DomainError(409, "TAG_CONFLICT", "GitLab 中该版本 tag 已指向其他提交。为保护已有版本，托管上传不会移动 tag。");
}

function releaseConflict(): DomainError {
  return new DomainError(409, "RELEASE_CONFLICT", "GitLab 中该版本 Release 已关联其他提交。为保护已有版本，托管上传不会覆盖 Release。");
}

function stateConflict(): DomainError {
  return new DomainError(409, "MANAGED_SOURCE_CONFLICT", "托管发布状态与持久化检查点不一致，已停止写入以保护源码和版本记录。");
}

function gitlabUnavailable(): DomainError {
  return new DomainError(503, "SOURCE_UNAVAILABLE", "暂时无法确认 GitLab 项目或提交状态，请使用相同幂等键重试。");
}
