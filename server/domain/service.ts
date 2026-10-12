import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "./errors.js";
import type { Database, Queryable } from "./database.js";
import {
  GitLabSourceReader,
  validateProjectId,
  type AppSource,
  type LoadedSource,
  type SourceInput,
} from "./gitlab-source.js";
import type { AgentEntry, AppManifest, StoredAppManifest } from "./manifest.js";

export interface AppView {
  id: string;
  revision: number;
  manifest: StoredAppManifest;
  version: string;
  createdAt: string;
  updatedAt: string;
  source: AppSource;
  documents: Record<string, string>;
}

export type PublicationStatus = "checking" | "preview_ready" | "registered" | "failed" | "cancelled";

export interface PublicationView {
  id: string;
  status: PublicationStatus;
  revision: number;
  digest?: string;
  preview?: AppView;
  appId?: string;
  error?: { code: string; message: string };
  nextAction: string;
  expiresAt: string;
}

export interface SubmitInput extends SourceInput {
  expectedAppRevision?: number;
}

export interface SubmitResult extends PublicationView {
  ticket: string;
  previewUrl: string;
}

export interface ServiceConfig {
  db: Database;
  gitlabUrl: string;
  publicOrigin: string;
  secret: string;
  audience: string;
}

export interface PlazaService {
  cleanupExpiredTokens(): Promise<void>;
  submit(input: SubmitInput, gitlabToken: string, idempotencyKey: string): Promise<SubmitResult>;
  publication(id: string, ticket: string): Promise<PublicationView>;
  confirm(id: string, ticket: string, confirmation: { revision: number; digest: string }): Promise<PublicationView>;
  retry(id: string, ticket: string): Promise<PublicationView>;
  list(options?: { query?: string; tags?: string[]; page?: number }): Promise<{ items: AppView[]; total: number; page: number; pageSize: 8; tags: string[] }>;
  app(id: string): Promise<AppView>;
  instructions(id: string, entryId: string): Promise<{ text: string; compatibility: string[]; source: AppSource }>;
}

interface PublicationRecord {
  id: string;
  actor_id: string;
  idempotency_digest: string;
  request_hash: string;
  submission: SubmitInput | string;
  status: PublicationStatus;
  revision: number;
  digest: string | null;
  candidate_app_id: string;
  expected_app_revision: number | null;
  app_id: string | null;
  preview_jsonb: AppView | string | null;
  token_ciphertext: string | null;
  token_iv: string | null;
  token_auth_tag: string | null;
  confirmed_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  next_action: string;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AppRecord {
  id: string;
  instance_id: string;
  project_id: string;
  app_key: string;
  current_snapshot_id: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  snap_id: string | null;
  commit_sha: string | null;
  manifest_path: string | null;
  tag: string | null;
  digest: string | null;
  audience: string | null;
  version: string | null;
  manifest: StoredAppManifest | string | null;
  documents: Record<string, string> | string | null;
  project_url: string | null;
  source_created_at: Date | string | null;
}

interface EncryptedToken {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const PUBLICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 8 as const;
const APP_SELECT = `
  SELECT a.id, a.instance_id, a.project_id, a.app_key, a.current_snapshot_id, a.revision,
         a.created_at, a.updated_at, s.id AS snap_id, s.commit_sha, s.manifest_path, s.tag,
         s.digest, s.audience, s.version, s.manifest, s.documents, s.project_url, s.source_created_at
    FROM catalog_apps a
    LEFT JOIN published_snapshots s ON s.id = a.current_snapshot_id`;

export function createService(config: ServiceConfig): PlazaService {
  const reader = new GitLabSourceReader(config.gitlabUrl);
  const publicOrigin = normalizePublicOrigin(config.publicOrigin);
  if (Buffer.byteLength(config.secret, "utf8") < 32) throw new Error("Publication secret must be at least 32 bytes.");
  if (!config.audience.trim()) throw new Error("A fixed catalog audience must be configured.");
  const secret = Buffer.from(config.secret, "utf8");
  const encryptionKey = createHash("sha256").update("ai-app-plaza/token-encryption/v1\0").update(secret).digest();
  const instanceId = reader.baseUrl.toString().replace(/\/$/, "");

  const cleanupExpiredTokens = async () => {
    await config.db.query(
      `UPDATE publications SET token_ciphertext = NULL, token_iv = NULL, token_auth_tag = NULL, updated_at = now()
        WHERE expires_at <= now() AND token_ciphertext IS NOT NULL`,
    );
  };

  function ticketFor(publicationId: string): string {
    return createHmac("sha256", secret).update(`publication-ticket-v1:${publicationId}`).digest("base64url");
  }

  function checkTicket(record: PublicationRecord, ticket: string): void {
    let received: Buffer;
    try {
      received = Buffer.from(ticket, "base64url");
    } catch {
      received = Buffer.alloc(0);
    }
    const expected = Buffer.from(ticketFor(record.id), "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw notFound();
    }
  }

  async function loadPublication(id: string, ticket: string): Promise<PublicationRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || typeof ticket !== "string" || ticket.length > 256) throw notFound();
    const result = await config.db.query<PublicationRecord>("SELECT * FROM publications WHERE id = $1", [id]);
    const record = result.rows[0];
    if (!record) throw notFound();
    checkTicket(record, ticket);
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      await config.db.query(
        `UPDATE publications SET token_ciphertext = NULL, token_iv = NULL, token_auth_tag = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      throw notFound();
    }
    return record;
  }

  function encryptToken(token: string): EncryptedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url"), authTag: cipher.getAuthTag().toString("base64url") };
  }

  function decryptToken(record: PublicationRecord): string {
    if (!record.token_ciphertext || !record.token_iv || !record.token_auth_tag) {
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "发布凭据已失效，请重新提交候选。");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(record.token_iv, "base64url"));
      decipher.setAuthTag(Buffer.from(record.token_auth_tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.token_ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new DomainError(503, "SOURCE_UNAVAILABLE", "发布凭据无法解密，请重新提交候选。");
    }
  }

  function recordView(record: PublicationRecord): PublicationView {
    const view: PublicationView = {
      id: record.id,
      status: record.status,
      revision: record.revision,
      nextAction: record.next_action,
      expiresAt: asIso(record.expires_at),
    };
    if (record.digest) view.digest = record.digest;
    if (record.preview_jsonb) view.preview = parseJsonValue<AppView>(record.preview_jsonb);
    if (record.app_id) view.appId = record.app_id;
    if (record.error_code && record.error_message) {
      view.error = { code: record.error_code, message: record.error_message };
    }
    return view;
  }

  function submitView(record: PublicationRecord): SubmitResult {
    const ticket = ticketFor(record.id);
    const view = recordView(record);
    const url = new URL("/", publicOrigin);
    url.hash = `publish=${record.id}&key=${ticket}`;
    return { ...view, ticket, previewUrl: url.toString() };
  }

  function getInput(record: PublicationRecord): SubmitInput {
    return parseJsonValue<SubmitInput>(record.submission);
  }

  async function findAppByKey(
    queryable: Queryable,
    projectId: string,
    appKey: string,
    lock = false,
  ): Promise<AppRecord | undefined> {
    const result = await queryable.query<AppRecord>(
      `${APP_SELECT} WHERE a.instance_id = $1 AND a.project_id = $2 AND a.app_key = $3${lock ? " FOR UPDATE OF a" : ""}`,
      [instanceId, projectId, appKey],
    );
    return result.rows[0];
  }

  async function findAppById(id: string, queryable: Queryable = config.db): Promise<AppRecord | undefined> {
    const result = await queryable.query<AppRecord>(`${APP_SELECT} WHERE a.id = $1 AND s.audience = $2`, [id, config.audience]);
    return result.rows[0];
  }

  function appView(record: AppRecord, docs: boolean): AppView {
    if (!record.snap_id || !record.manifest || !record.commit_sha || !record.manifest_path || !record.version || !record.project_url) {
      throw new DomainError(404, "APP_NOT_FOUND", "应用不存在。");
    }
    const source: AppSource = {
      projectId: record.project_id,
      projectUrl: record.project_url,
      commitSha: record.commit_sha,
      manifestPath: record.manifest_path,
      ...(record.tag ? { tag: record.tag } : {}),
    };
    return {
      id: record.id,
      revision: record.revision,
      manifest: parseJsonValue<StoredAppManifest>(record.manifest),
      version: record.version,
      createdAt: asIso(record.created_at),
      updatedAt: asIso(record.updated_at),
      source,
      documents: docs ? parseJsonValue<Record<string, string>>(record.documents ?? {}) : {},
    };
  }

  function candidateView(
    candidateAppId: string,
    existing: AppRecord | undefined,
    input: SubmitInput,
    source: LoadedSource,
  ): AppView {
    const now = new Date().toISOString();
    return {
      id: existing?.id ?? candidateAppId,
      revision: (existing?.revision ?? 0) + 1,
      manifest: source.manifest,
      version: source.version,
      createdAt: existing ? asIso(existing.created_at) : source.sourceCreatedAt,
      updatedAt: now,
      source: source.source,
      documents: source.documents,
    };
  }

  async function markFailed(
    id: string,
    error: unknown,
    retryAllowed = true,
  ): Promise<PublicationRecord> {
    const failure = safeFailure(error);
    const mustSubmitAgain = failure.code === "SOURCE_MISMATCH" || failure.code === "VALIDATION_FAILED" ||
      failure.code === "AUTH_TOKEN_INVALID" || failure.code === "REVISION_CONFLICT";
    const nextAction = mustSubmitAgain
      ? "submit_again"
      : retryAllowed ? "retry" : "submit_again";
    await config.db.query(
      `UPDATE publications
          SET status = 'failed', error_code = $2, error_message = $3, next_action = $4,
              confirmed_at = CASE WHEN $2 IN ('SOURCE_MISMATCH', 'VALIDATION_FAILED', 'AUTH_TOKEN_INVALID', 'REVISION_CONFLICT') THEN NULL ELSE confirmed_at END,
              updated_at = now()
        WHERE id = $1 AND status <> 'registered'`,
      [id, failure.code, failure.message, nextAction],
    );
    const result = await config.db.query<PublicationRecord>("SELECT * FROM publications WHERE id = $1", [id]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  async function preparePreview(record: PublicationRecord, source: LoadedSource): Promise<PublicationRecord> {
    const input = getInput(record);
    const projectId = validateProjectId(input.projectId);
    return config.db.transaction(async (tx) => {
      const locked = (await tx.query<PublicationRecord>("SELECT * FROM publications WHERE id = $1 FOR UPDATE", [record.id])).rows[0];
      if (!locked) throw notFound();
      if (locked.status === "registered") return locked;
      const existing = await findAppByKey(tx, projectId, input.appKey, true);
      const currentRevision = existing?.revision ?? 0;
      if (input.expectedAppRevision !== undefined && input.expectedAppRevision !== currentRevision) {
        throw new DomainError(409, "REVISION_CONFLICT", "应用修订已变化，请重新提交候选并查看新预览。");
      }
      if (
        existing?.digest === source.digest &&
        existing.commit_sha === source.source.commitSha &&
        existing.audience === config.audience
      ) {
        const current = appView(existing, true);
        const updated = await tx.query<PublicationRecord>(
          `UPDATE publications
              SET status = 'registered', app_id = $2, preview_jsonb = $3::jsonb, digest = $4,
                  expected_app_revision = $5, error_code = NULL, error_message = NULL,
                  next_action = 'complete', token_ciphertext = NULL, token_iv = NULL, token_auth_tag = NULL,
                  updated_at = now()
            WHERE id = $1 RETURNING *`,
          [record.id, existing.id, JSON.stringify(current), source.digest, currentRevision],
        );
        return updated.rows[0]!;
      }

      const view = candidateView(locked.candidate_app_id, existing, input, source);
      const updated = await tx.query<PublicationRecord>(
        `UPDATE publications
            SET status = 'preview_ready', digest = $2, expected_app_revision = $3,
                preview_jsonb = $4::jsonb, app_id = NULL, error_code = NULL, error_message = NULL,
                next_action = 'confirm', updated_at = now()
          WHERE id = $1 RETURNING *`,
        [record.id, source.digest, currentRevision, JSON.stringify(view)],
      );
      return updated.rows[0]!;
    });
  }

  async function assertAuthorAndSource(record: PublicationRecord): Promise<LoadedSource> {
    const token = decryptToken(record);
    const { actorId } = await reader.currentUser(token);
    if (actorId !== record.actor_id) {
      throw new DomainError(403, "PERMISSION_DENIED", "当前 GitLab 授权身份与候选提交者不一致。");
    }
    return reader.load(getInput(record), token);
  }

  async function register(record: PublicationRecord, source: LoadedSource): Promise<PublicationRecord> {
    if (!record.digest || record.digest !== source.digest) {
      throw new DomainError(409, "SOURCE_MISMATCH", "固定来源内容已变化，请重新提交并确认新的预览。");
    }
    const input = getInput(record);
    const projectId = validateProjectId(input.projectId);
    return config.db.transaction(async (tx) => {
      const lockedPublication = (await tx.query<PublicationRecord>("SELECT * FROM publications WHERE id = $1 FOR UPDATE", [record.id])).rows[0];
      if (!lockedPublication) throw notFound();
      if (lockedPublication.status === "registered") return lockedPublication;
      if (lockedPublication.revision !== record.revision || lockedPublication.digest !== record.digest) {
        throw new DomainError(409, "SOURCE_MISMATCH", "候选修订或摘要已变化，请重新提交预览。");
      }
      if (!lockedPublication.confirmed_at) {
        throw new DomainError(409, "CONFIRMATION_REQUIRED", "请先确认与当前摘要一致的预览。");
      }

      let app = await findAppByKey(tx, projectId, input.appKey, true);
      if (
        app?.digest === source.digest &&
        app.commit_sha === source.source.commitSha &&
        app.audience === config.audience
      ) {
        const existingView = appView(app, true);
        const updated = await tx.query<PublicationRecord>(
          `UPDATE publications
              SET status = 'registered', app_id = $2, preview_jsonb = $3::jsonb,
                  error_code = NULL, error_message = NULL, next_action = 'complete',
                  token_ciphertext = NULL, token_iv = NULL, token_auth_tag = NULL, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [record.id, app.id, JSON.stringify(existingView)],
        );
        return updated.rows[0]!;
      }

      const currentRevision = app?.revision ?? 0;
      if (lockedPublication.expected_app_revision !== currentRevision) {
        throw new DomainError(409, "REVISION_CONFLICT", "应用修订已变化，旧预览不能覆盖新版本，请重新提交候选。");
      }
      const now = new Date();
      const appId = app?.id ?? lockedPublication.candidate_app_id;
      if (!app) {
        const createdApp = await tx.query(
          `INSERT INTO catalog_apps (id, instance_id, project_id, app_key, revision, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, $5)
           ON CONFLICT (instance_id, project_id, app_key) DO NOTHING RETURNING id`,
          [appId, instanceId, projectId, input.appKey, source.sourceCreatedAt],
        );
        const insertedApp = await findAppByKey(tx, projectId, input.appKey, true);
        if (!insertedApp) throw new Error("App row disappeared while registering its first snapshot.");
        app = insertedApp;
        if (createdApp.rowCount === 0 && app.revision !== currentRevision) {
          if (app.digest === source.digest && app.commit_sha === source.source.commitSha && app.audience === config.audience) {
            const existingView = appView(app, true);
            const updated = await tx.query<PublicationRecord>(
              `UPDATE publications
                  SET status = 'registered', app_id = $2, preview_jsonb = $3::jsonb,
                      error_code = NULL, error_message = NULL, next_action = 'complete',
                      token_ciphertext = NULL, token_iv = NULL, token_auth_tag = NULL, updated_at = now()
                WHERE id = $1 RETURNING *`,
              [record.id, app.id, JSON.stringify(existingView)],
            );
            return updated.rows[0]!;
          }
          throw new DomainError(409, "REVISION_CONFLICT", "另一个候选已先创建应用，旧预览不能覆盖新版本，请重新提交候选。");
        }
      }

      const nextRevision = currentRevision + 1;
      const existingSnapshot = (await tx.query<{ id: string }>(
        `SELECT id FROM published_snapshots WHERE app_id = $1 AND commit_sha = $2 AND digest = $3 AND audience = $4`,
        [appId, source.source.commitSha, source.digest, config.audience],
      )).rows[0];
      const snapshotId = existingSnapshot?.id ?? randomUUID();
      if (!existingSnapshot) {
        await tx.query(
          `INSERT INTO published_snapshots (
             id, app_id, commit_sha, manifest_path, tag, digest, audience, version,
             manifest, documents, search_text, project_url, source_created_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)`,
          [
            snapshotId,
            appId,
            source.source.commitSha,
            source.source.manifestPath,
            source.source.tag ?? null,
            source.digest,
            config.audience,
            source.version,
            JSON.stringify(source.manifest),
            JSON.stringify(source.documents),
            buildSearchText(source.manifest),
            source.source.projectUrl,
            source.sourceCreatedAt,
            now,
          ],
        );
      }
      await tx.query(
        `UPDATE catalog_apps SET current_snapshot_id = $2, revision = $3, updated_at = $4 WHERE id = $1`,
        [appId, snapshotId, nextRevision, now],
      );
      const savedApp = await findAppByKey(tx, projectId, input.appKey);
      if (!savedApp) throw new Error("Registered app row was not visible in its transaction.");
      const savedView = appView(savedApp, true);
      const updated = await tx.query<PublicationRecord>(
        `UPDATE publications
            SET status = 'registered', app_id = $2, preview_jsonb = $3::jsonb,
                error_code = NULL, error_message = NULL, next_action = 'complete',
                token_ciphertext = NULL, token_iv = NULL, token_auth_tag = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [record.id, appId, JSON.stringify(savedView)],
      );
      return updated.rows[0]!;
    });
  }

  async function updateConfirmed(id: string, revision: number, digest: string): Promise<PublicationRecord> {
    return config.db.transaction(async (tx) => {
      const current = (await tx.query<PublicationRecord>("SELECT * FROM publications WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!current) throw notFound();
      if (current.status === "registered") return current;
      if (current.status !== "preview_ready" || current.revision !== revision || current.digest !== digest) {
        throw new DomainError(409, "SOURCE_MISMATCH", "确认参数与当前预览修订或摘要不一致，请刷新预览。");
      }
      const updated = await tx.query<PublicationRecord>(
        `UPDATE publications SET confirmed_at = COALESCE(confirmed_at, now()), updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      return updated.rows[0]!;
    });
  }

  const service: PlazaService = {
    cleanupExpiredTokens,

    async submit(input, gitlabToken, idempotencyKey) {
      await cleanupExpiredTokens();
      validateSubmitInput(input, gitlabToken, idempotencyKey);
      const { actorId } = await reader.currentUser(gitlabToken);
      const requestHash = hashInput(input);
      const idempotencyDigest = createHmac("sha256", secret)
        .update(`idempotency-v1:${actorId}:${idempotencyKey}`)
        .digest("hex");
      const encrypted = encryptToken(gitlabToken);
      const now = new Date();
      const publicationId = randomUUID();
      const candidateAppId = randomUUID();
      const expiry = new Date(now.getTime() + PUBLICATION_TTL_MS);
      const created = await config.db.transaction(async (tx) => {
        const inserted = await tx.query<PublicationRecord>(
          `INSERT INTO publications (
             id, actor_id, idempotency_digest, request_hash, submission, status, revision,
             candidate_app_id, token_ciphertext, token_iv, token_auth_tag,
             next_action, expires_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, 'checking', 1, $6, $7, $8, $9, 'checking', $10, $11, $11)
           ON CONFLICT (actor_id, idempotency_digest) DO NOTHING RETURNING *`,
          [
            publicationId,
            actorId,
            idempotencyDigest,
            requestHash,
            JSON.stringify(input),
            candidateAppId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
            expiry,
            now,
          ],
        );
        if (inserted.rows[0]) return { record: inserted.rows[0], isNew: true };
        const existing = (await tx.query<PublicationRecord>(
          "SELECT * FROM publications WHERE actor_id = $1 AND idempotency_digest = $2 FOR UPDATE",
          [actorId, idempotencyDigest],
        )).rows[0];
        if (!existing) throw new Error("Idempotency conflict row was not visible.");
        if (existing.request_hash !== requestHash) {
          throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "相同幂等键已用于不同的候选内容。");
        }
        return { record: existing, isNew: false };
      });
      if (!created.isNew) return submitView(created.record);

      try {
        const source = await reader.load(input, gitlabToken);
        const prepared = await preparePreview(created.record, source);
        return submitView(prepared);
      } catch (error) {
        return submitView(await markFailed(created.record.id, error));
      }
    },

    async publication(id, ticket) {
      await cleanupExpiredTokens();
      return recordView(await loadPublication(id, ticket));
    },

    async confirm(id, ticket, confirmation) {
      await cleanupExpiredTokens();
      const record = await loadPublication(id, ticket);
      if (record.status === "registered") return recordView(record);
      if (!Number.isInteger(confirmation?.revision) || confirmation.revision < 1 || !/^[a-f0-9]{64}$/.test(confirmation?.digest ?? "")) {
        throw new DomainError(400, "VALIDATION_FAILED", "确认必须包含预览修订号和摘要。");
      }
      const confirmed = await updateConfirmed(id, confirmation.revision, confirmation.digest);
      if (confirmed.status === "registered") return recordView(confirmed);
      try {
        const source = await assertAuthorAndSource(confirmed);
        if (source.digest !== confirmation.digest) {
          throw new DomainError(409, "SOURCE_MISMATCH", "固定来源内容已变化，请重新提交并确认新的预览。");
        }
        const registered = await register(confirmed, source);
        return recordView(registered);
      } catch (error) {
        return recordView(await markFailed(id, error));
      }
    },

    async retry(id, ticket) {
      await cleanupExpiredTokens();
      const record = await loadPublication(id, ticket);
      if (record.status === "registered") return recordView(record);
      if (record.status === "preview_ready") return recordView(record);
      if (record.status === "cancelled") throw new DomainError(409, "PUBLICATION_CANCELLED", "该发布候选已取消。");
      if (record.next_action === "submit_again") {
        throw new DomainError(409, record.error_code ?? "SOURCE_MISMATCH", record.error_message ?? "当前候选需要重新提交并生成新的预览。");
      }
      try {
        const source = await assertAuthorAndSource(record);
        if (record.confirmed_at) {
          if (!record.digest || source.digest !== record.digest) {
            throw new DomainError(409, "SOURCE_MISMATCH", "固定来源内容已变化，请重新提交并确认新的预览。");
          }
          return recordView(await register(record, source));
        }
        return recordView(await preparePreview(record, source));
      } catch (error) {
        return recordView(await markFailed(id, error));
      }
    },

    async list(options = {}) {
      await cleanupExpiredTokens();
      const page = options.page ?? 1;
      if (!Number.isInteger(page) || page < 1 || page > 100_000) {
        throw new DomainError(400, "VALIDATION_FAILED", "page 必须是有效的正整数。");
      }
      const tokens = searchTokens(options.query ?? "");
      // Filter the original displayed labels; PostgreSQL applies case folding to both sides.
      const requestedTags = (options.tags ?? []).filter(tag => tag.trim());
      if (requestedTags.length > 12) throw new DomainError(400, "VALIDATION_FAILED", "一次最多筛选 12 个标签。");
      const filters: string[] = ["s.audience = $1"];
      const params: unknown[] = [config.audience];
      for (const group of tokens) {
        const alternatives: string[] = [];
        for (const token of group) {
          params.push(token);
          const placeholder = `$${params.length}`;
          alternatives.push(`position(${placeholder} in s.search_text) > 0`);
          alternatives.push(`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(s.manifest->'tags') AS tag(value)
             WHERE position(${placeholder} in lower(tag.value)) > 0
          )`);
        }
        filters.push(`(${alternatives.join(" OR ")})`);
      }
      for (const tag of [...new Set(requestedTags)]) {
        params.push(tag);
        filters.push(`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(s.manifest->'tags') AS tag(value)
           WHERE lower(tag.value) = lower($${params.length})
        )`);
      }
      const where = filters.join(" AND ");
      const totalResult = await config.db.query<{ total: string | number }>(
        `SELECT count(*) AS total FROM catalog_apps a JOIN published_snapshots s ON s.id = a.current_snapshot_id WHERE ${where}`,
        params,
      );
      const total = Number(totalResult.rows[0]?.total ?? 0);
      const tagResult = await config.db.query<{ tag: string }>(
        `SELECT DISTINCT tag.value AS tag
           FROM catalog_apps a JOIN published_snapshots s ON s.id = a.current_snapshot_id
           CROSS JOIN LATERAL jsonb_array_elements_text(s.manifest->'tags') AS tag(value)
          WHERE s.audience = $1 ORDER BY tag.value`,
        [config.audience],
      );
      const itemParams = [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE];
      const limitParam = `$${itemParams.length - 1}`;
      const offsetParam = `$${itemParams.length}`;
      const itemResult = await config.db.query<AppRecord>(
        `${APP_SELECT} WHERE ${where} ORDER BY lower(s.manifest->>'name'), a.id LIMIT ${limitParam} OFFSET ${offsetParam}`,
        itemParams,
      );
      return {
        items: itemResult.rows.map((row) => appView(row, false)),
        total,
        page,
        pageSize: PAGE_SIZE,
        tags: tagResult.rows.map((row) => row.tag),
      };
    },

    async app(id) {
      await cleanupExpiredTokens();
      const record = await findAppById(id);
      if (!record) throw new DomainError(404, "APP_NOT_FOUND", "应用不存在。");
      return appView(record, true);
    },

    async instructions(id, entryId) {
      await cleanupExpiredTokens();
      const record = await findAppById(id);
      if (!record) throw new DomainError(404, "APP_NOT_FOUND", "应用不存在。");
      const view = appView(record, true);
      const entry = view.manifest.entries.find((item): item is AgentEntry => item.id === entryId && item.kind === "agent");
      if (!entry) throw new DomainError(404, "ENTRY_NOT_FOUND", "Agent 接入入口不存在。");
      const text = view.documents[entry.instructionsPath];
      if (typeof text !== "string") throw new DomainError(404, "ENTRY_NOT_FOUND", "该入口的固定版本说明不可用。");
      const artifacts = entry.artifacts?.length
        ? `\n\n## 声明产物\n${entry.artifacts.map((artifact) => `- ${artifact.url}（SHA-256: \`${artifact.sha256}\`）`).join("\n")}`
        : "";
      const context = [
        `# ${view.manifest.name} · ${view.version}`,
        `来源项目：${view.source.projectUrl}`,
        `固定 commit：\`${view.source.commitSha}\``,
        `接入说明路径：\`${entry.instructionsPath}\``,
        "请在自己的 Agent/Host 环境核对授权并按说明操作；广场收录或复制说明不代表应用已下载、安装或运行成功。",
        artifacts,
      ].filter(Boolean).join("\n\n");
      return { text: `${context}\n\n---\n\n${text}`, compatibility: [...entry.compatibility], source: view.source };
    },
  };

  return service;
}

function normalizePublicOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("A valid public origin is required.");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Public origin must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  origin.pathname = "/";
  return origin;
}

function validateSubmitInput(input: SubmitInput, token: string, idempotencyKey: string): void {
  if (!input || typeof input !== "object") throw new DomainError(400, "VALIDATION_FAILED", "发布候选参数无效。");
  validateProjectId(input.projectId);
  if (typeof token !== "string" || token.length < 1 || token.length > 8192 || /[\r\n\u0000]/.test(token)) {
    throw new DomainError(401, "AUTH_TOKEN_INVALID", "请提供有效的 GitLab 只读授权。");
  }
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new DomainError(400, "VALIDATION_FAILED", "Idempotency-Key 格式无效。");
  }
  if (input.expectedAppRevision !== undefined && (!Number.isInteger(input.expectedAppRevision) || input.expectedAppRevision < 0)) {
    throw new DomainError(400, "VALIDATION_FAILED", "expectedAppRevision 必须是非负整数。");
  }
}

function hashInput(input: SubmitInput): string {
  const stable = {
    projectId: String(input.projectId),
    appKey: input.appKey,
    manifestPath: input.manifestPath,
    commitSha: input.commitSha,
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.expectedAppRevision === undefined ? {} : { expectedAppRevision: input.expectedAppRevision }),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function parseJsonValue<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof DomainError) return { code: error.code, message: error.message };
  return { code: "SOURCE_UNAVAILABLE", message: "暂时无法完成 GitLab 来源核验，请稍后重试。" };
}

function notFound(): DomainError {
  return new DomainError(404, "PUBLICATION_NOT_FOUND", "发布记录不存在。");
}

function searchTokens(query: string): string[][] {
  if (typeof query !== "string") throw new DomainError(400, "VALIDATION_FAILED", "query 必须是文本。");
  if (query.length > 200) throw new DomainError(400, "VALIDATION_FAILED", "query 不能超过 200 个字符。");
  const normalized = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const groups: string[][] = [];
  let word = "";
  let han = "";
  const flushWord = () => {
    if (word) groups.push([word]);
    word = "";
  };
  const flushHan = () => {
    if (han.length === 1) groups.push([han]);
    else if (han.length > 1) {
      const alternatives = [han];
      for (let index = 0; index < han.length - 1; index++) alternatives.push(han.slice(index, index + 2));
      groups.push([...new Set(alternatives)]);
    }
    han = "";
  };
  for (const character of normalized) {
    if (/\p{Script=Han}/u.test(character)) {
      flushWord();
      han += character;
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      flushHan();
      word += character;
    } else {
      flushHan();
      flushWord();
    }
  }
  flushHan();
  flushWord();
  return groups.slice(0, 20);
}

function buildSearchText(manifest: AppManifest): string {
  const text = [
    manifest.name,
    manifest.summary,
    ...manifest.capabilities.scenarios,
    ...manifest.capabilities.inputs,
    ...manifest.capabilities.outputs,
    ...manifest.examples.flatMap((example) => [example.request, example.expectedResult]),
  ];
  return text.join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN");
}
