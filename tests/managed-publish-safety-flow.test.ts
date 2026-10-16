import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  businessTableSnapshot,
  downloadPublisherCli,
  getSafetyReceipt,
  gitlabWriteCalls,
  makeSafetyBundle,
  newPublishKey,
  receiptDirectorySnapshot,
  runPublisherCli,
  SYNTHETIC_LEGACY_REFERENCE_FIXTURE,
  SERVER_ONLY_SENTINEL,
  startSafetyPortal,
  submitSafetyBundle,
  validateSafetyBundle,
  writeSafetyProject,
  type SafetyHttpResponse,
  type SafetyPortal,
} from "./helpers/managed-publish-safety-flow.js";

const APP_KEY = "sample-safety-flow";

function errorDiagnostics(response: SafetyHttpResponse): Array<Record<string, unknown>> {
  const diagnostics = response.json.error?.diagnostics;
  assert.ok(Array.isArray(diagnostics), "validation errors expose structured diagnostics");
  return diagnostics as Array<Record<string, unknown>>;
}

function assertSafeSecretDiagnostics(diagnostics: Array<Record<string, unknown>>, projectRoot: string): void {
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.some((item) =>
    item.code === "SECRET_MARKER_FOUND" &&
    typeof item.ruleId === "string" && /^managed\.bundle\.[a-z0-9_]+$/.test(item.ruleId) &&
    item.path === "src/server-only.ts",
  ), "the server-only secret is identified by a stable rule and repository-relative path");
  for (const item of diagnostics) {
    assert.deepEqual(Object.keys(item).sort(), Object.keys(item).filter((key) =>
      ["code", "ruleId", "path", "field", "line", "column", "suggestion"].includes(key),
    ).sort(), "diagnostics contain only safe locator fields");
    assert.equal(typeof item.code, "string");
    assert.equal(typeof item.ruleId, "string");
    assert.equal(typeof item.suggestion, "string");
    assert.ok(String(item.suggestion).length > 0);
    if (item.path !== undefined) {
      assert.equal(typeof item.path, "string");
      assert.ok(!path.isAbsolute(String(item.path)));
    }
    for (const field of ["line", "column"]) {
      if (item[field] !== undefined) assert.ok(typeof item[field] === "number" && Number.isInteger(item[field]) && Number(item[field]) > 0);
    }
  }
  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes(SERVER_ONLY_SENTINEL));
  assert.ok(!serialized.includes(projectRoot));
  assert.ok(!serialized.includes(projectRoot.replaceAll("\\", "/")));
}

function assertNoFixtureSecrets(value: string, projectRoot: string): void {
  assert.ok(!value.includes(SERVER_ONLY_SENTINEL));
  assert.ok(!value.includes("private-preview.invalid"));
  assert.ok(!value.includes(projectRoot));
  assert.ok(!value.includes(projectRoot.replaceAll("\\", "/")));
}

function parseCliJson(stdout: string): Record<string, any> {
  try {
    return JSON.parse(stdout) as Record<string, any>;
  } catch {
    throw new Error("publisher CLI did not return its documented JSON result");
  }
}

function managedRequests(portal: SafetyPortal, method: string, route: string) {
  return portal.requests.filter((request) => request.method === method && request.path === route);
}

test("managed publish preflight blocks a server-only secret with shared safe diagnostics", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "plaza-publish-preflight-"));
  let portal: SafetyPortal | undefined;
  t.after(async () => {
    await portal?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  portal = await startSafetyPortal();

  const projectRoot = await writeSafetyProject(temporary, APP_KEY, true);
  const scriptPath = await downloadPublisherCli(portal.origin, path.join(temporary, "publisher-cli.py"));
  const stateDir = path.join(temporary, "private-state");
  const databaseBefore = await businessTableSnapshot(portal);
  const gitlabWritesBefore = gitlabWriteCalls(portal);
  const receiptDirectoryBefore = await receiptDirectorySnapshot(stateDir);
  const cli = await runPublisherCli(scriptPath, [
    "--origin", portal.origin,
    "--project", projectRoot,
    "--state-dir", stateDir,
    "--validate",
  ]);
  assert.equal(cli.code, 2, "the server-side secret preflight stops the official CLI");
  const cliResult = parseCliJson(cli.stdout);
  assert.equal(cliResult.status, "validation_failed");
  assert.equal(cliResult.published, false);
  assert.equal(cliResult.sourceUploaded, false);
  assertSafeSecretDiagnostics(cliResult.diagnostics, projectRoot);
  assertNoFixtureSecrets(`${cli.stdout}\n${cli.stderr}`, projectRoot);
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptDirectoryBefore,
    "preflight leaves the private receipt directory and its bytes untouched");
  assert.equal(managedRequests(portal, "POST", "/api/managed-publications").length, 0,
    "the official CLI stops after preflight and never probes the formal endpoint");

  const bundle = makeSafetyBundle(APP_KEY, true);
  assert.ok(Object.values(databaseBefore).every((tableRows) => tableRows.length === 0));
  const previewOne = await validateSafetyBundle(portal, bundle);
  const previewTwo = await validateSafetyBundle(portal, bundle);
  for (const preview of [previewOne, previewTwo]) {
    assert.equal(preview.status, 400);
    assert.equal(preview.json.error?.code, "VALIDATION_FAILED");
  }
  const diagnostics = errorDiagnostics(previewOne);
  assertSafeSecretDiagnostics(diagnostics, projectRoot);
  assertNoFixtureSecrets(previewOne.text, projectRoot);
  assert.deepEqual(errorDiagnostics(previewTwo), diagnostics, "repeated preflight is deterministic");
  assert.deepEqual(
    (cliResult.diagnostics as Array<Record<string, unknown>>).map(({ suggestion: _suggestion, ...locator }) => locator),
    diagnostics.map(({ suggestion: _suggestion, ...locator }) => locator),
    "the CLI preserves the server-side diagnostic locators while safely normalizing suggestion text",
  );

  const validationRequests = managedRequests(portal, "POST", "/api/managed-publications/validate");
  assert.equal(validationRequests.length, 3);
  assert.ok(validationRequests.every((request) => request.ownerKey === undefined && request.idempotencyKey === undefined),
    "preflight does not require publish-owner or idempotency headers");

  const ownerKey = newPublishKey();
  const idempotencyKey = randomUUID();
  const formal = await submitSafetyBundle(portal, bundle, ownerKey, idempotencyKey);
  assert.equal(formal.status, 400);
  assert.equal(formal.json.error?.code, "VALIDATION_FAILED");
  assertNoFixtureSecrets(formal.text, projectRoot);
  assert.deepEqual(errorDiagnostics(formal), diagnostics,
    "preflight and formal submission reject the same package with identical safe diagnostics");
  assert.equal(managedRequests(portal, "POST", "/api/managed-publications").length, 1,
    "only the explicit negative regression request reached formal submit");

  const unknown = await getSafetyReceipt(portal, ownerKey, idempotencyKey);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error?.code, "MANAGED_OPERATION_NOT_FOUND");
  assert.equal(managedRequests(portal, "GET", "/api/managed-publications/receipt").at(-1)?.bodyPresent, false);
  assert.deepEqual(await businessTableSnapshot(portal), databaseBefore,
    "invalid preflights and the rejected formal request leave all business-table contents unchanged");
  assert.deepEqual(gitlabWriteCalls(portal), gitlabWritesBefore);
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptDirectoryBefore);
  assert.equal(portal.gitlab.state.requests.length, 0, "validation performs no GitLab protocol reads or writes");
});

test("managed publish preserves the original operation through refusal, response loss, and receipt recovery", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "plaza-publish-recovery-"));
  let portal: SafetyPortal | undefined;
  t.after(async () => {
    await portal?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  portal = await startSafetyPortal();

  const contractResponse = await fetch(`${portal.origin}/api/publish-contract`);
  assert.equal(contractResponse.status, 200);
  const contract = await contractResponse.json() as { prompt?: unknown };
  assert.equal(typeof contract.prompt, "string");
  assert.match(contract.prompt as string, /--validate[\s\S]*--status[\s\S]*--recover/);
  assert.match(contract.prompt as string, /禁止对正式发布接口[\s\S]*小包[\s\S]*--validate/);
  assert.match(contract.prompt as string, /不要自行编写 HTTP 上传脚本/);

  const bundle = makeSafetyBundle(APP_KEY);
  assert.equal((bundle.files as unknown[]).length, 3, "the legitimate minimal app contains exactly a manifest and two declared documents");
  const projectRoot = await writeSafetyProject(temporary, APP_KEY);
  const scriptPath = await downloadPublisherCli(portal.origin, path.join(temporary, "publisher-cli.py"));
  const stateDir = path.join(temporary, "private-state");
  const cliArgs = ["--origin", portal.origin, "--project", projectRoot, "--state-dir", stateDir];
  const emptyDatabase = await businessTableSnapshot(portal);
  const emptyGitLabWrites = gitlabWriteCalls(portal);
  const emptyReceiptDirectory = await receiptDirectorySnapshot(stateDir);

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runPublisherCli(scriptPath, [...cliArgs, "--validate"]);
    assert.equal(result.code, 0, "valid preflight exits successfully");
    const output = parseCliJson(result.stdout);
    assert.equal(output.status, "validated");
    assert.equal(output.published, false);
    assert.equal(output.sourceUploaded, false);
    assert.equal(typeof output.fileCount, "number");
    assert.equal(output.fileCount, 3);
  }
  const validPreview = await validateSafetyBundle(portal, bundle);
  assert.equal(validPreview.status, 200);
  assert.deepEqual(
    { status: validPreview.json.status, published: validPreview.json.published, sourceUploaded: validPreview.json.sourceUploaded },
    { status: "validated", published: false, sourceUploaded: false },
  );
  assert.equal(managedRequests(portal, "POST", "/api/managed-publications").length, 0);
  assert.deepEqual(await businessTableSnapshot(portal), emptyDatabase,
    "repeated valid preflight leaves every business row unchanged");
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), emptyReceiptDirectory,
    "repeated valid preflight does not create or alter the local receipt directory");
  assert.deepEqual(gitlabWriteCalls(portal), emptyGitLabWrites);
  assert.ok(managedRequests(portal, "POST", "/api/managed-publications/validate")
    .every((request) => request.ownerKey === undefined && request.idempotencyKey === undefined));

  const ownerKey = newPublishKey();
  const idempotencyKey = randomUUID();
  const databaseBeforeMissingReceipt = await businessTableSnapshot(portal);
  const gitlabBeforeMissingReceipt = gitlabWriteCalls(portal);
  const receiptBeforeMissingReceipt = await receiptDirectorySnapshot(stateDir);
  const missing = await getSafetyReceipt(portal, ownerKey, idempotencyKey);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error?.code, "MANAGED_OPERATION_NOT_FOUND");
  assert.deepEqual(await businessTableSnapshot(portal), databaseBeforeMissingReceipt);
  assert.deepEqual(gitlabWriteCalls(portal), gitlabBeforeMissingReceipt);
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptBeforeMissingReceipt);

  assert.equal(SYNTHETIC_LEGACY_REFERENCE_FIXTURE.projectCreateRejectionStatus, 400);
  assert.equal(SYNTHETIC_LEGACY_REFERENCE_FIXTURE.projectReadbackUnavailableStatus, 503);
  assert.equal(SYNTHETIC_LEGACY_REFERENCE_FIXTURE.exactRequestReplay, false);
  assert.equal(SYNTHETIC_LEGACY_REFERENCE_FIXTURE.exactResponseReplay, false);
  portal.gitlab.state.rejectNextProjectStatus = SYNTHETIC_LEGACY_REFERENCE_FIXTURE.projectCreateRejectionStatus;
  const beforeSynthetic400 = await businessTableSnapshot(portal);
  const gitlabWritesBeforeSynthetic400 = gitlabWriteCalls(portal);
  const refused = await submitSafetyBundle(portal, bundle, ownerKey, idempotencyKey);
  assert.equal(refused.status, 400, "the local GitLab protocol fixture injects a project-create HTTP 400");
  assert.equal(refused.json.error?.code, "MANAGED_PROJECT_CREATE_REJECTED");
  assertNoFixtureSecrets(refused.text, projectRoot);
  assert.equal(portal.gitlab.state.projects.size, 0);
  assert.deepEqual(gitlabWriteCalls(portal).slice(gitlabWritesBeforeSynthetic400.length), [
    { method: "POST", path: "/api/v4/projects" },
  ],
    "the confirmed GitLab 400 is returned precisely and no source commit is written");
  assert.notDeepEqual(await businessTableSnapshot(portal), beforeSynthetic400,
    "the failed formal request retains its original operation for safe recovery");

  const beforePendingReceipt = await businessTableSnapshot(portal);
  const gitlabBeforePendingReceipt = gitlabWriteCalls(portal);
  const pending = await getSafetyReceipt(portal, ownerKey, idempotencyKey);
  assert.equal(pending.status, 200);
  assert.deepEqual(
    {
      status: pending.json.status,
      nextAction: pending.json.nextAction,
      recoveryRequired: pending.json.recoveryRequired,
      sourceUploaded: pending.json.sourceUploaded,
    },
    { status: "recovery_required", nextAction: "retry_original", recoveryRequired: true, sourceUploaded: false },
  );
  assert.deepEqual(await businessTableSnapshot(portal), beforePendingReceipt);
  assert.deepEqual(gitlabWriteCalls(portal), gitlabBeforePendingReceipt);

  const submitted = await submitSafetyBundle(portal, bundle, ownerKey, idempotencyKey);
  assert.equal(submitted.status, 201, "the original legal three-file package succeeds on same-key retry");
  assert.equal(submitted.json.status, "preview_ready");
  assert.equal(submitted.json.sourceUploaded, true);
  assert.equal(typeof submitted.json.managedAppId, "string");
  const firstIdentityRequests = managedRequests(portal, "POST", "/api/managed-publications").slice(-2);
  assert.equal(firstIdentityRequests[0]!.ownerKey, ownerKey);
  assert.equal(firstIdentityRequests[1]!.ownerKey, ownerKey);
  assert.equal(firstIdentityRequests[0]!.idempotencyKey, idempotencyKey);
  assert.equal(firstIdentityRequests[1]!.idempotencyKey, idempotencyKey);
  assert.deepEqual(firstIdentityRequests[0]!.body, firstIdentityRequests[1]!.body,
    "the original owner, key, and exact three-file bundle are retained after the refusal");

  // Synthetic reference-client behavior: it keeps only `error` from the 201 body and does not hand off the preview.
  // This models the reported client mistake without replaying captured historical request/response bytes.
  const syntheticLegacyClient = {
    fixtureId: SYNTHETIC_LEGACY_REFERENCE_FIXTURE.id,
    responseProjection: { error: submitted.json.error ?? null },
    previewHandoff: false,
  };
  assert.equal(submitted.status, 201);
  assert.equal(typeof submitted.json.managedAppId, "string");
  assert.equal(typeof submitted.json.previewUrl, "string");
  assert.deepEqual(Object.keys(syntheticLegacyClient.responseProjection), ["error"]);
  assert.equal(syntheticLegacyClient.previewHandoff, false);

  const differentIdempotencyKey = randomUUID();
  assert.notEqual(differentIdempotencyKey, idempotencyKey);
  const beforeDifferentIdempotencyLookup = await businessTableSnapshot(portal);
  const gitlabBeforeDifferentIdempotencyLookup = gitlabWriteCalls(portal);
  const receiptBeforeDifferentIdempotencyLookup = await receiptDirectorySnapshot(stateDir);
  const differentIdempotencyReceipt = await getSafetyReceipt(portal, ownerKey, differentIdempotencyKey);
  assert.equal(differentIdempotencyReceipt.status, 404);
  assert.equal(differentIdempotencyReceipt.json.error?.code, "MANAGED_OPERATION_NOT_FOUND");
  assert.equal(managedRequests(portal, "GET", "/api/managed-publications/receipt").at(-1)?.bodyPresent, false);
  assert.deepEqual(await businessTableSnapshot(portal), beforeDifferentIdempotencyLookup,
    "receipt lookup for the correct owner and a different idempotency key leaves all business rows unchanged");
  assert.deepEqual(gitlabWriteCalls(portal), gitlabBeforeDifferentIdempotencyLookup,
    "a missing receipt lookup makes no GitLab writes");
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptBeforeDifferentIdempotencyLookup,
    "a missing receipt lookup does not alter the local receipt directory or bytes");

  const beforeMissingManagedId = await businessTableSnapshot(portal);
  const writesBeforeMissingManagedId = gitlabWriteCalls(portal);
  const sameOwnerNewKey = await submitSafetyBundle(portal, bundle, ownerKey, randomUUID());
  assert.equal(sameOwnerNewKey.status, 403);
  assert.equal(sameOwnerNewKey.json.error?.code, "MANAGED_APP_OWNER_REQUIRED");
  assert.deepEqual(await businessTableSnapshot(portal), beforeMissingManagedId,
    "a new same-owner key without managedAppId cannot create a second operation");
  assert.deepEqual(gitlabWriteCalls(portal), writesBeforeMissingManagedId,
    "the invalid same-owner follow-up stops before another GitLab write");

  const beforeFirstReceipt = await businessTableSnapshot(portal);
  const gitlabBeforeFirstReceipt = gitlabWriteCalls(portal);
  const receiptDirectoryBeforeFirstReceipt = await receiptDirectorySnapshot(stateDir);
  const firstReceipt = await getSafetyReceipt(portal, ownerKey, idempotencyKey);
  assert.equal(firstReceipt.status, 200);
  assert.equal(firstReceipt.json.status, "preview_ready");
  assert.equal(firstReceipt.json.managedAppId, submitted.json.managedAppId);
  assert.equal(firstReceipt.json.previewUrl, submitted.json.previewUrl);
  assert.equal(firstReceipt.json.sourceUploaded, true);
  assert.deepEqual(Object.keys(firstReceipt.json).sort(), Object.keys(submitted.json).sort(),
    "a completed receipt read returns the normal submit result");
  const firstReceiptRequest = managedRequests(portal, "GET", "/api/managed-publications/receipt").at(-1)!;
  assert.equal(firstReceiptRequest.ownerKey, ownerKey);
  assert.equal(firstReceiptRequest.idempotencyKey, idempotencyKey);
  assert.equal(firstReceiptRequest.bodyPresent, false);
  assert.deepEqual(await businessTableSnapshot(portal), beforeFirstReceipt,
    "the original operation remains retrievable without changing any business row");
  assert.deepEqual(gitlabWriteCalls(portal), gitlabBeforeFirstReceipt);
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptDirectoryBeforeFirstReceipt);

  const beforeWrongOwnerReceipt = await businessTableSnapshot(portal);
  const gitlabBeforeWrongOwnerReceipt = gitlabWriteCalls(portal);
  const wrongOwner = await getSafetyReceipt(portal, newPublishKey(), idempotencyKey);
  assert.equal(wrongOwner.status, 404);
  assert.equal(wrongOwner.json.error?.code, "MANAGED_OPERATION_NOT_FOUND");
  assert.ok(!wrongOwner.text.includes(APP_KEY));
  assert.ok(!wrongOwner.text.includes(String(submitted.json.managedAppId)));
  assert.ok(!wrongOwner.text.includes(String(submitted.json.previewUrl)));
  assert.deepEqual(await businessTableSnapshot(portal), beforeWrongOwnerReceipt);
  assert.deepEqual(gitlabWriteCalls(portal), gitlabBeforeWrongOwnerReceipt);

  const databaseBeforeConflict = await businessTableSnapshot(portal);
  const beforeConflict = gitlabWriteCalls(portal);
  const alteredBundle = structuredClone(bundle) as Record<string, any>;
  const readme = alteredBundle.files.find((file: { path: string }) => file.path === "README.md");
  readme.content = Buffer.from("# 同键异体\n", "utf8").toString("base64");
  const conflict = await submitSafetyBundle(portal, alteredBundle, ownerKey, idempotencyKey);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error?.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await businessTableSnapshot(portal), databaseBeforeConflict);
  assert.deepEqual(gitlabWriteCalls(portal), beforeConflict, "same-key different-body is rejected before another GitLab write");
  const stableReceipt = await getSafetyReceipt(portal, ownerKey, idempotencyKey);
  assert.equal(stableReceipt.json.previewUrl, submitted.json.previewUrl);
  assert.equal(stableReceipt.json.managedAppId, submitted.json.managedAppId);

  const formalCountBeforeLostResponse = managedRequests(portal, "POST", "/api/managed-publications").length;
  portal.dropNextSubmitResponse();
  const lost = await runPublisherCli(scriptPath, cliArgs);
  assert.notEqual(lost.code, 0, "the CLI does not treat a lost 201 as a completed handoff");
  assert.match(`${lost.stdout}\n${lost.stderr}`, /恢复|receipt|recover/i);
  assertNoFixtureSecrets(`${lost.stdout}\n${lost.stderr}`, projectRoot);
  const afterLostResponse = managedRequests(portal, "POST", "/api/managed-publications");
  assert.equal(afterLostResponse.length, formalCountBeforeLostResponse + 1,
    "one and only one formal request was made for the lost response");
  const lostSubmission = afterLostResponse.at(-1)!;
  assert.ok(lostSubmission.ownerKey);
  assert.ok(lostSubmission.idempotencyKey);
  const receiptAfterLostResponse = await receiptDirectorySnapshot(stateDir);
  assert.equal(receiptAfterLostResponse.exists, true);
  assert.equal(receiptAfterLostResponse.kind, "directory");
  assert.equal(receiptAfterLostResponse.entries.length, 1, "the original local receipt survives the lost 201");
  assert.equal(receiptAfterLostResponse.entries[0]!.kind, "file");
  assert.equal(receiptAfterLostResponse.entries[0]!.name.endsWith(".receipt"), true);
  assert.deepEqual(
    (lostSubmission.body as { files: Array<{ path: string }> }).files.map((file) => file.path).sort(),
    ["README.md", "ai-app.json", "docs/usage.md"],
    "the original three-file package was submitted as one legal application",
  );

  const requestsBeforeStatus = portal.requests.length;
  const receiptBeforeStatus = await receiptDirectorySnapshot(stateDir);
  const status = await runPublisherCli(scriptPath, [...cliArgs, "--status"]);
  assert.equal(status.code, 0, "local status succeeds without network access");
  const statusResult = parseCliJson(status.stdout);
  assert.equal(statusResult.status, "receipt_saved");
  assert.equal(statusResult.appKey, APP_KEY);
  assert.equal(portal.requests.length, requestsBeforeStatus, "--status reads only the local receipt and makes no HTTP request");
  assert.equal(managedRequests(portal, "POST", "/api/managed-publications").length, formalCountBeforeLostResponse + 1);
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptBeforeStatus,
    "--status does not change the receipt directory or file bytes");

  const databaseBeforeRecovery = await businessTableSnapshot(portal);
  const writesBeforeRecovery = gitlabWriteCalls(portal);
  const receiptBeforeRecovery = await receiptDirectorySnapshot(stateDir);
  const recoveredRun = await runPublisherCli(scriptPath, [...cliArgs, "--recover"]);
  assert.equal(recoveredRun.code, 0, "receipt recovery returns the original preview");
  const recovered = parseCliJson(recoveredRun.stdout);
  assert.equal(recovered.status, "preview_ready");
  if (statusResult.managedAppId !== undefined) assert.equal(recovered.managedAppId, statusResult.managedAppId);
  assert.equal(recovered.sourceUploaded, true);
  assert.equal(recovered.handoffState, "complete");
  assert.equal(typeof recovered.previewUrl, "string");
  assertNoFixtureSecrets(`${recoveredRun.stdout}\n${recoveredRun.stderr}`, projectRoot);

  const recoveryReads = managedRequests(portal, "GET", "/api/managed-publications/receipt").filter((request) =>
    request.ownerKey === lostSubmission.ownerKey && request.idempotencyKey === lostSubmission.idempotencyKey,
  );
  assert.equal(recoveryReads.length, 1, "recovery queries the exact original owner and idempotency key once");
  assert.equal(recoveryReads[0]!.bodyPresent, false);
  assert.equal(managedRequests(portal, "POST", "/api/managed-publications").length, formalCountBeforeLostResponse + 1,
    "recovery does not resubmit the source or mint a replacement operation");
  assert.deepEqual(await businessTableSnapshot(portal), databaseBeforeRecovery,
    "receipt recovery leaves every business-table row unchanged");
  assert.deepEqual(gitlabWriteCalls(portal), writesBeforeRecovery,
    "receipt recovery makes no additional GitLab write calls");
  const receiptAfterRecovery = await receiptDirectorySnapshot(stateDir);
  assert.equal(receiptAfterRecovery.exists, receiptBeforeRecovery.exists);
  assert.equal(receiptAfterRecovery.kind, receiptBeforeRecovery.kind);
  assert.deepEqual(receiptAfterRecovery.entries.map(({ name, kind }) => ({ name, kind })),
    receiptBeforeRecovery.entries.map(({ name, kind }) => ({ name, kind })),
    "recovery keeps the same one-file receipt directory shape");
  assert.notEqual(receiptAfterRecovery.entries[0]!.sha256, receiptBeforeRecovery.entries[0]!.sha256,
    "recovery persists the retrieved preview into the existing receipt");

  const recoveredReceipt = await getSafetyReceipt(portal, lostSubmission.ownerKey!, lostSubmission.idempotencyKey!);
  assert.equal(recoveredReceipt.status, 200);
  assert.equal(recoveredReceipt.json.status, "preview_ready");
  assert.equal(recoveredReceipt.json.managedAppId, recovered.managedAppId);
  assert.equal(recoveredReceipt.json.previewUrl, recovered.previewUrl);
  assert.equal(recoveredReceipt.json.sourceUploaded, true);
  assert.deepEqual(await businessTableSnapshot(portal), databaseBeforeRecovery);
  assert.deepEqual(gitlabWriteCalls(portal), writesBeforeRecovery);
  assert.deepEqual(await receiptDirectorySnapshot(stateDir), receiptAfterRecovery,
    "the original operation receipt lookup remains read-only after recovery");

  const projects = [...portal.gitlab.state.projects.values()];
  assert.equal(projects.length, 2, "the two independent synthetic owners have isolated projects");
  const projectByManagedId = new Map([
    [String(submitted.json.managedAppId), projects.find((project) => project.path.endsWith(String(submitted.json.managedAppId).replaceAll("-", "").slice(0, 16)))],
    [String(recovered.managedAppId), projects.find((project) => project.path.endsWith(String(recovered.managedAppId).replaceAll("-", "").slice(0, 16)))],
  ]);
  assert.equal(projectByManagedId.size, 2);
  for (const [managedAppId, project] of projectByManagedId) {
    assert.ok(project);
    const expectedPath = `${APP_KEY}-${managedAppId.replaceAll("-", "").slice(0, 16)}`;
    assert.equal(project.path, expectedPath);
    assert.equal(project.name, `${expectedPath} · AI 应用广场`);
  }
  assert.equal(new Set(projects.map((project) => project.path)).size, 2);
  assert.equal(new Set(projects.map((project) => project.name)).size, 2,
    "same appKey under new identities remains unique within the GitLab namespace");
});
