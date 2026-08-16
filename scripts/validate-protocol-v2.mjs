import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v2Root = path.join(repoRoot, "docs", "v2");
const manifestPath = path.join(v2Root, "test-vectors", "manifest.json");
const failures = [];
const checks = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  checks.push(message);
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    fail(`${path.relative(repoRoot, file)}: invalid JSON (${error.message})`);
    return null;
  }
}

function walk(directory, suffix) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target, suffix) : target.endsWith(suffix) ? [target] : [];
  });
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function resolvePointer(document, fragment) {
  if (!fragment || fragment === "#") return document;
  if (!fragment.startsWith("#/")) return undefined;
  return fragment
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], document);
}

function messageTypes(schema) {
  return (schema.oneOf ?? []).flatMap((option) => {
    const definition = resolvePointer(schema, option.$ref);
    let result;
    visit(definition, (node) => {
      if (typeof node?.properties?.type?.const === "string") result = node.properties.type.const;
    });
    return result ? [result] : [];
  });
}

function formatErrors(errors) {
  return (errors ?? []).slice(0, 6).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function buildSchemaValidators(manifest) {
  const schemaDir = path.join(v2Root, "schemas");
  const files = walk(schemaDir, ".schema.json");
  const documents = new Map(files.map((file) => [file, readJson(file)]));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  for (const [file, document] of documents) {
    if (!document) continue;
    if (document.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail(`${path.relative(repoRoot, file)}: must use JSON Schema 2020-12`);
    }
    visit(document, (node) => {
      if (typeof node.$ref !== "string" || node.$ref.startsWith("http")) return;
      const [relativeFile, rawFragment] = node.$ref.split("#");
      const targetFile = relativeFile ? path.resolve(path.dirname(file), relativeFile) : file;
      const target = documents.get(targetFile);
      if (!target) {
        fail(`${path.relative(repoRoot, file)}: missing schema ref ${node.$ref}`);
      } else if (rawFragment && resolvePointer(target, `#${rawFragment}`) === undefined) {
        fail(`${path.relative(repoRoot, file)}: unresolved schema ref ${node.$ref}`);
      }
    });
    try {
      ajv.addSchema(document);
    } catch (error) {
      fail(`${path.relative(repoRoot, file)}: schema registration failed (${error.message})`);
    }
  }

  const client = readJson(path.resolve(path.dirname(manifestPath), manifest.sources.client_schema));
  const server = readJson(path.resolve(path.dirname(manifestPath), manifest.sources.server_schema));
  let validators;
  try {
    validators = {
      client: ajv.getSchema(client.$id) ?? ajv.compile(client),
      server: ajv.getSchema(server.$id) ?? ajv.compile(server)
    };
  } catch (error) {
    fail(`JSON Schema compilation failed: ${error.message}`);
  }

  const actualClient = messageTypes(client).sort();
  const actualServer = messageTypes(server).sort();
  if (JSON.stringify(actualClient) !== JSON.stringify([...manifest.required_client_message_types].sort())) {
    fail(`client message types differ from manifest: ${actualClient.join(", ")}`);
  }
  if (JSON.stringify(actualServer) !== JSON.stringify([...manifest.required_server_message_types].sort())) {
    fail(`server message types differ from manifest: ${actualServer.join(", ")}`);
  }

  const contractText = JSON.stringify([...documents.values()]);
  for (const legacy of ["assistant.text", "input.transcript", "output.text.done", "output.audio", "native_audio", "dictation", "transcribe", "partial"]) {
    if (contractText.includes(legacy)) fail(`legacy WS contract token remains: ${legacy}`);
  }
  const clientText = JSON.stringify(client);
  if (!clientText.includes('"auth"') || !clientText.includes('"not"')) {
    fail("client.hello must explicitly reject legacy auth after ticket upgrade");
  }
  if (!clientText.includes('"conversation_id"') || !clientText.includes('"task"')) {
    fail("request.start must explicitly reject legacy conversation_id and task fields");
  }
  if (!clientText.includes("asr_only") || !clientText.includes("asr_llm")) {
    fail("client schema must define asr_only and asr_llm modes");
  }
  const serverText = JSON.stringify(server);
  for (const required of ["output.text.delta", "output.text.snapshot", "final_text", '"result":{"const":"success"}']) {
    if (!serverText.includes(required)) fail(`server schema missing unified temporary-text constraint: ${required}`);
  }
  for (const required of ["asr_credits", "llm_credits", "asr_credits_charged", "llm_credits_charged"]) {
    if (!serverText.includes(required) && !contractText.includes(required)) {
      fail(`WebSocket schemas missing split billing field: ${required}`);
    }
  }

  pass(`${files.length} JSON Schema 2020-12 files compiled; 5 client and 9 server message types fixed`);
  return validators;
}

async function validateOpenApi() {
  const openapiPath = path.join(v2Root, "openapi", "openapi.yaml");
  let api;
  try {
    api = await SwaggerParser.validate(openapiPath);
  } catch (error) {
    fail(`OpenAPI validation failed: ${error.message}`);
    return;
  }

  const expected = new Map([
    ["/v2/auth/authorize", ["get"]],
    ["/v2/auth/token", ["post"]],
    ["/v2/auth/refresh", ["post"]],
    ["/v2/auth/logout", ["post"]],
    ["/v2/users/me", ["get"]],
    ["/v2/quota", ["get"]],
    ["/v2/usage", ["get"]],
    ["/v2/capabilities", ["get"]],
    ["/v2/realtime/tickets", ["post"]]
  ]);
  const actualPaths = Object.keys(api.paths ?? {}).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expected.keys()].sort())) {
    fail(`OpenAPI paths differ from expected v2 surface: ${actualPaths.join(", ")}`);
  }
  let operationCount = 0;
  for (const [route, methods] of expected) {
    for (const method of methods) {
      operationCount += 1;
      if (!api.paths?.[route]?.[method]?.operationId) fail(`${method.toUpperCase()} ${route} lacks operationId`);
    }
  }

  if ((api.paths?.["/v2/auth/authorize"]?.get?.security ?? null)?.length !== 0 ||
      (api.paths?.["/v2/auth/token"]?.post?.security ?? null)?.length !== 0 ||
      (api.paths?.["/v2/auth/refresh"]?.post?.security ?? null)?.length !== 0) {
    fail("authorize, token, and refresh must explicitly disable global Bearer security");
  }
  if (api.paths?.["/v2/auth/logout"]?.post?.requestBody !== undefined) {
    fail("logout must be Bearer-only and must not declare a request body");
  }
  const ticket = api.components?.schemas?.RealtimeTicket;
  if (!ticket?.required?.includes("ticket") || ticket?.properties?.ticket?.writeOnly === true) {
    fail("RealtimeTicket.ticket must be a readable required response property");
  }
  if (ticket?.properties?.ticket?.["x-sensitive"] !== true) {
    fail("RealtimeTicket.ticket must be marked x-sensitive");
  }
  const capabilities = api.components?.schemas?.Capabilities;
  const realtime = api.components?.schemas?.RealtimeCapability;
  if (realtime?.properties?.persistent?.const !== true) fail("capabilities must declare persistent realtime=true");
  if (realtime?.properties?.ticket_path?.const !== "/v2/realtime/tickets") fail("capabilities ticket_path mismatch");
  const modeValues = api.components?.schemas?.Mode?.enum ?? [];
  if (JSON.stringify([...modeValues].sort()) !== JSON.stringify(["asr_llm", "asr_only"])) {
    fail("OpenAPI Mode must contain exactly asr_only and asr_llm");
  }
  const apiText = JSON.stringify(api);
  for (const forbiddenPath of ["/v2/voices", "/v2/conversations"]) {
    if (apiText.includes(forbiddenPath)) fail(`removed HTTP resource remains: ${forbiddenPath}`);
  }
  for (const forbiddenProperty of ["conversation_id", "voice_cloning", "emotion_control", "validated_conversation_turns"]) {
    if (apiText.includes(`\"${forbiddenProperty}\"`)) fail(`removed HTTP property remains: ${forbiddenProperty}`);
  }
  if (!capabilities?.required?.includes("realtime") || !capabilities?.required?.includes("modes")) {
    fail("Capabilities must require realtime and modes");
  }
  if (!capabilities?.required?.includes("defaults") || capabilities?.properties?.default_pipeline !== undefined ||
      api.components?.schemas?.DefaultPipelines !== undefined) {
    fail("Capabilities.defaults must be the only default Pipeline authority");
  }
  const refreshConflictCodes = api.paths?.["/v2/auth/refresh"]?.post?.responses?.["409"]?.content?.["application/json"]?.schema?.allOf?.[1]?.properties?.error?.properties?.code?.enum ?? [];
  for (const code of ["idempotency_conflict", "idempotency_result_expired", "refresh_token_reused"]) {
    if (!refreshConflictCodes.includes(code)) fail(`refresh 409 response must include ${code}`);
  }
  const authorizeParameters = api.paths?.["/v2/auth/authorize"]?.get?.parameters ?? [];
  const authorizeParameter = (name) => authorizeParameters.find((parameter) => parameter.name === name)?.schema;
  if (authorizeParameter("client_id")?.const !== "mindsurf-desktop" ||
      authorizeParameter("response_type")?.const !== "code" ||
      authorizeParameter("redirect_uri")?.const !== "mindsurf://auth/callback" ||
      authorizeParameter("code_challenge_method")?.const !== "S256" ||
      authorizeParameter("state")?.pattern !== "^[A-Za-z0-9_-]{43,512}$") {
    fail("authorize must fix the desktop client, code flow, callback, and S256 PKCE method");
  }
  const authorizationCodeInput = api.components?.schemas?.AuthorizationCodeInput;
  for (const field of ["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "device"]) {
    if (!authorizationCodeInput?.required?.includes(field)) fail(`AuthorizationCodeInput must require ${field}`);
  }
  if (authorizationCodeInput?.properties?.code_verifier?.writeOnly !== true ||
      authorizationCodeInput?.properties?.code?.writeOnly !== true) {
    fail("Authorization Code and PKCE verifier must be writeOnly");
  }
  if (api.components?.schemas?.LoginInput || api.paths?.["/v2/auth/login"] || apiText.includes('"password"')) {
    fail("desktop password login must not remain in the OpenAPI contract");
  }
  const idempotencyParameter = api.components?.parameters?.IdempotencyKey;
  if (idempotencyParameter?.name !== "Idempotency-Key" || idempotencyParameter?.required !== true) {
    fail("OpenAPI must define required Idempotency-Key");
  }
  for (const route of ["/v2/auth/token", "/v2/auth/refresh"]) {
    const parameters = api.paths?.[route]?.post?.parameters ?? [];
    if (!parameters.some((parameter) => parameter.$ref === "#/components/parameters/IdempotencyKey" || parameter.name === "Idempotency-Key")) {
      fail(`${route} must require Idempotency-Key`);
    }
  }
  const tokenPair = api.components?.schemas?.TokenPair;
  for (const field of ["access_token", "refresh_token"]) {
    if (tokenPair?.properties?.[field]?.["x-sensitive"] !== true) fail(`TokenPair.${field} must be marked x-sensitive`);
  }
  const user = api.components?.schemas?.User;
  if (!user?.required?.includes("user_id") || user?.properties?.id !== undefined) {
    fail("User must expose user_id and must not expose ambiguous id");
  }
  for (const schemaName of ["ResourceUsage", "UsageEntry"]) {
    const required = api.components?.schemas?.[schemaName]?.required ?? [];
    for (const field of ["asr_credits_charged", "llm_credits_charged", "credits_charged"]) {
      if (!required.includes(field)) fail(`${schemaName} must require split billing field ${field}`);
    }
  }

  pass(`${actualPaths.length} OpenAPI paths and ${operationCount} operations validated as OpenAPI 3.1`);
}

function validateMarkdownExamples(manifest, validators) {
  if (!validators) return;
  const file = path.resolve(path.dirname(manifestPath), manifest.sources.ws_document);
  const text = readText(file);
  const examples = [];
  const blockPattern = /```json\s*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(blockPattern)) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.v === 2 && typeof value?.type === "string") examples.push(value);
    } catch (error) {
      fail(`${path.relative(repoRoot, file)}: invalid JSON block (${error.message})`);
    }
  }

  const byType = new Map();
  for (const example of examples) {
    const direction = manifest.required_client_message_types.includes(example.type) ? "client" :
      manifest.required_server_message_types.includes(example.type) ? "server" : null;
    if (!direction) {
      fail(`documentation example uses undeclared WS type ${example.type}`);
      continue;
    }
    const validate = validators[direction];
    if (!validate(example)) fail(`invalid ${example.type} documentation example: ${formatErrors(validate.errors)}`);
    const reservation = example.payload?.quota_reservation;
    if (reservation && reservation.credits !== reservation.asr_credits + reservation.llm_credits) {
      fail(`invalid ${example.type} documentation example: quota reservation total mismatch`);
    }
    const usage = example.payload?.usage;
    if (usage && usage.credits_charged !== usage.asr_credits_charged + usage.llm_credits_charged) {
      fail(`invalid ${example.type} documentation example: usage total mismatch`);
    }
    byType.set(example.type, (byType.get(example.type) ?? 0) + 1);
  }

  for (const type of [...manifest.required_client_message_types, ...manifest.required_server_message_types]) {
    if (!byType.has(type)) fail(`WebSocket documentation lacks JSON example for ${type}`);
  }
  pass(`${examples.length} WebSocket documentation examples validated across 14 message types`);
}

function validateInvalidMessages(manifest, validators) {
  if (!validators) return;
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.invalid_json);
  const vectors = readJson(file);
  for (const testCase of vectors?.cases ?? []) {
    const validate = validators[testCase.direction];
    if (!validate) {
      fail(`${testCase.name}: invalid direction ${testCase.direction}`);
      continue;
    }
    if (validate(testCase.message)) fail(`negative JSON vector unexpectedly accepted: ${testCase.name}`);
  }
  pass(`${vectors?.cases?.length ?? 0} negative JSON vectors rejected`);
}

function browserAuthorizationViolation(attempt, testCase) {
  const callback = testCase.callback ?? {};
  const hasCode = typeof callback.code === "string";
  const hasError = typeof callback.error === "string";
  if (hasCode === hasError) return "callback_result_ambiguous";
  if (callback.state !== attempt.state) return "callback_state_mismatch";
  if (hasError) {
    if (!["access_denied", "temporarily_unavailable"].includes(callback.error) || testCase.token_request) {
      return "invalid_error_callback";
    }
    return null;
  }
  const request = testCase.token_request;
  if (!request || request.code !== callback.code) return "authorization_code_mismatch";
  if (request.client_id !== attempt.client_id || request.redirect_uri !== attempt.redirect_uri) {
    return "authorization_binding_mismatch";
  }
  const challenge = createHash("sha256").update(request.code_verifier, "ascii").digest("base64url");
  if (challenge !== attempt.code_challenge) return "pkce_verification_failed";
  if (testCase.code_status !== "fresh") return "authorization_code_not_fresh";
  return null;
}

function validateBrowserAuthorization(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.browser_authorization);
  const vectors = readJson(file);
  const computedChallenge = createHash("sha256").update(vectors.attempt.code_verifier, "ascii").digest("base64url");
  if (computedChallenge !== vectors.attempt.code_challenge) fail("browser authorization fixture has an invalid PKCE challenge");
  for (const testCase of vectors?.cases ?? []) {
    const violation = browserAuthorizationViolation(vectors.attempt, testCase);
    if (testCase.valid && violation) fail(`valid browser authorization vector rejected (${testCase.name}): ${violation}`);
    if (!testCase.valid && violation !== testCase.expected_rule) {
      fail(`invalid browser authorization vector ${testCase.name} produced ${violation ?? "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} browser authorization and PKCE vectors checked`);
}

function authIdempotencyOutcome(testCase) {
  if (testCase.retry.key === testCase.first.key) {
    if (testCase.retry.fingerprint !== testCase.first.fingerprint) return "idempotency_conflict";
    if (testCase.operation === "refresh" && testCase.result_available === false) {
      return "idempotency_result_expired";
    }
    return "replay_original_result";
  }
  if (testCase.operation === "refresh" && testCase.credential_status === "rotated") return "refresh_token_reused";
  if (testCase.operation === "token" && testCase.credential_status === "consumed") return "authorization_grant_invalid";
  return "new_operation";
}

function validateAuthIdempotency(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.auth_idempotency);
  const vectors = readJson(file);
  for (const testCase of vectors?.cases ?? []) {
    const outcome = authIdempotencyOutcome(testCase);
    if (outcome !== testCase.expected_outcome) {
      fail(`auth idempotency vector ${testCase.name} produced ${outcome}, expected ${testCase.expected_outcome}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} token and refresh idempotency vectors checked`);
}

function validateSessionParameters(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.session_parameters);
  const vectors = readJson(file);
  for (const testCase of vectors?.cases ?? []) {
    const violation = testCase.heartbeat_timeout_ms < testCase.heartbeat_interval_ms ? null :
      "heartbeat_timeout_not_less_than_interval";
    if (testCase.valid && violation) fail(`valid session parameter vector rejected (${testCase.name}): ${violation}`);
    if (!testCase.valid && violation !== testCase.expected_rule) {
      fail(`invalid session parameter vector ${testCase.name} produced ${violation ?? "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} heartbeat parameter vectors checked`);
}

function modePipelineViolation(capabilities, request) {
  if (request.capabilities_revision !== capabilities.revision) return "capabilities_revision_mismatch";
  const pipeline = capabilities.pipelines.find((item) => item.id === request.pipeline);
  if (!pipeline) return "pipeline_not_found";
  if (!pipeline.modes.includes(request.mode)) return "pipeline_mode_not_supported";
  if (!pipeline.asr_options.includes(request.selection?.asr)) return "asr_not_available";
  if (request.mode === "asr_only" && request.selection?.llm !== null) return "asr_only_llm_must_be_null";
  if (request.mode === "asr_llm" && !request.selection?.llm) return "asr_llm_llm_required";
  if (request.mode === "asr_llm" && !pipeline.llm_options.includes(request.selection.llm)) return "llm_not_available";
  if (!capabilities.recognition_languages.includes(request.language)) return "language_not_available";
  for (const [key, value] of Object.entries(request.generation ?? {})) {
    const control = pipeline.generation_controls[key];
    if (!control) return "generation_key_not_available";
    if (typeof value !== "number" || !Number.isFinite(value) || (control.type === "integer" && !Number.isInteger(value))) {
      return "generation_type_mismatch";
    }
    if (value < control.minimum || value > control.maximum) return "generation_value_out_of_range";
  }
  return null;
}

function capabilityCatalogViolations(capabilities) {
  const violations = [];
  const uniqueIds = (items, label) => {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) violations.push(`duplicate_${label}_id`);
    return new Set(ids);
  };
  const pipelineIds = uniqueIds(capabilities.pipelines ?? [], "pipeline");
  const asrIds = uniqueIds(capabilities.asr_options ?? [], "asr_option");
  const llmIds = uniqueIds(capabilities.llm_options ?? [], "llm_option");

  for (const pipeline of capabilities.pipelines ?? []) {
    if ((pipeline.asr_options ?? []).some((id) => !asrIds.has(id))) violations.push("dangling_pipeline_asr_option");
    if ((pipeline.llm_options ?? []).some((id) => !llmIds.has(id))) violations.push("dangling_pipeline_llm_option");
    for (const control of Object.values(pipeline.generation_controls ?? {})) {
      if (control.minimum > control.default || control.default > control.maximum) {
        violations.push("generation_default_out_of_range");
      }
      if (control.type === "integer" && ![control.minimum, control.default, control.maximum].every(Number.isInteger)) {
        violations.push("generation_integer_metadata_fractional");
      }
    }
  }

  for (const mode of ["asr_only", "asr_llm"]) {
    const value = capabilities.defaults?.[mode];
    const pipeline = capabilities.pipelines?.find((item) => item.id === value?.pipeline);
    if (!value || !pipelineIds.has(value.pipeline) || !pipeline) {
      violations.push(`invalid_${mode}_default_pipeline`);
      continue;
    }
    if (!pipeline.modes.includes(mode)) violations.push(`invalid_${mode}_default_mode`);
    if (!pipeline.asr_options.includes(value.selection?.asr)) violations.push(`invalid_${mode}_default_asr`);
    if (mode === "asr_only" && value.selection?.llm !== null) violations.push("invalid_asr_only_default_llm");
    if (mode === "asr_llm" && (!value.selection?.llm || !pipeline.llm_options.includes(value.selection.llm))) {
      violations.push("invalid_asr_llm_default_llm");
    }
  }
  return [...new Set(violations)];
}

function validateModePipelines(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.mode_pipeline_requests);
  const vectors = readJson(file);
  for (const violation of capabilityCatalogViolations(vectors.capabilities)) {
    fail(`capability catalog fixture violates ${violation}`);
  }
  for (const testCase of vectors.catalog_cases ?? []) {
    const capabilities = structuredClone(vectors.capabilities);
    switch (testCase.mutation) {
      case "duplicate_pipeline_id":
        capabilities.pipelines.push({ ...structuredClone(capabilities.pipelines[0]) });
        break;
      case "dangling_pipeline_asr_option":
        capabilities.pipelines[0].asr_options = ["missing-asr"];
        break;
      case "default_pipeline_wrong_mode":
        capabilities.defaults.asr_only.pipeline = "opaque-b";
        break;
      case "default_llm_not_in_pipeline":
        capabilities.defaults.asr_llm.selection.llm = "missing-llm";
        break;
      case "generation_default_out_of_range":
        capabilities.pipelines[1].generation_controls.temperature.default = 2;
        break;
      default:
        fail(`unknown capability catalog mutation: ${testCase.mutation}`);
        continue;
    }
    const violations = capabilityCatalogViolations(capabilities);
    if (!violations.includes(testCase.expected_rule)) {
      fail(`invalid capability catalog ${testCase.name} produced ${violations.join(", ") || "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  for (const testCase of vectors?.cases ?? []) {
    const violation = modePipelineViolation(vectors.capabilities, testCase.request);
    if (testCase.valid && violation) fail(`valid mode/Pipeline vector rejected (${testCase.name}): ${violation}`);
    if (!testCase.valid && violation !== testCase.expected_rule) {
      fail(`invalid mode/Pipeline vector ${testCase.name} produced ${violation ?? "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  pass(`${vectors?.catalog_cases?.length ?? 0} invalid capability catalogs and ${vectors?.cases?.length ?? 0} cross-resource mode/Pipeline vectors checked`);
}

function billingViolation(testCase) {
  const { mode, reservation, usage } = testCase;
  if (reservation.credits !== reservation.asr_credits + reservation.llm_credits) {
    return "reservation_total_mismatch";
  }
  if (usage.credits_charged !== usage.asr_credits_charged + usage.llm_credits_charged) {
    return "usage_total_mismatch";
  }
  if (mode === "asr_only" && (
    reservation.llm_credits !== 0 ||
    usage.llm_input_tokens !== 0 ||
    usage.llm_output_tokens !== 0 ||
    usage.llm_credits_charged !== 0
  )) {
    return "asr_only_llm_usage_nonzero";
  }
  if (usage.asr_credits_charged > reservation.asr_credits) return "asr_charge_exceeds_reservation";
  if (usage.llm_credits_charged > reservation.llm_credits) return "llm_charge_exceeds_reservation";
  return null;
}

function validateBillingUsage(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.billing_usage);
  const vectors = readJson(file);
  for (const testCase of vectors?.cases ?? []) {
    const violation = billingViolation(testCase);
    if (testCase.valid && violation) fail(`valid billing vector rejected (${testCase.name}): ${violation}`);
    if (!testCase.valid && violation !== testCase.expected_rule) {
      fail(`invalid billing vector ${testCase.name} produced ${violation ?? "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} split ASR/LLM billing vectors checked`);
}

function lifecycleViolation(events) {
  let mode;
  let inputCommitted = false;
  const nextDeltaSequence = { asr: 0, llm: 0 };
  let asrReadyForLlm = false;
  let llmStarted = false;
  let finalText;
  let terminal = false;

  for (const event of events) {
    if (event.type.startsWith("session.")) continue;
    if (event.type === "request.cancel") continue;
    if (terminal) return "event_after_terminal";
    if (finalText !== undefined && event.type !== "request.done") return "final_not_followed_by_done";

    switch (event.type) {
      case "request.accepted":
        if (mode !== undefined) return "duplicate_accepted";
        mode = event.payload?.mode;
        break;
      case "input.committed":
        if (!mode) return "input_before_accepted";
        inputCommitted = true;
        break;
      case "output.text.delta":
        if (!mode) return "output_before_accepted";
        if (event.payload?.stage === "asr") {
          if (llmStarted) return "asr_output_after_llm_started";
          if (inputCommitted && mode === "asr_llm") asrReadyForLlm = false;
        } else if (event.payload?.stage === "llm") {
          if (!llmStarted) return "llm_output_before_stage_transition";
        } else {
          return "invalid_delta_stage";
        }
        if (event.payload?.sequence !== nextDeltaSequence[event.payload.stage]) return "invalid_delta_sequence";
        nextDeltaSequence[event.payload.stage] += 1;
        break;
      case "output.text.snapshot": {
        const { stage, text, final } = event.payload ?? {};
        if (!mode) return "output_before_accepted";
        if (stage === "asr") {
          if (llmStarted) return "asr_output_after_llm_started";
          if (final === true) {
            if (!inputCommitted) return "final_before_input_committed";
            if (mode !== "asr_only") return "snapshot_mode_mismatch";
            finalText = text;
          } else if (final === false) {
            if (inputCommitted && mode === "asr_llm") asrReadyForLlm = true;
          } else {
            return "snapshot_mode_mismatch";
          }
        } else if (stage === "llm") {
          if (mode !== "asr_llm" || !inputCommitted || !asrReadyForLlm) {
            return "llm_output_before_asr_complete";
          }
          if (!llmStarted) {
            if (final !== false || text !== "") return "invalid_llm_stage_transition";
            llmStarted = true;
          } else if (final === false) {
            return "duplicate_llm_stage_transition";
          } else if (final === true) {
            finalText = text;
          } else {
            return "snapshot_mode_mismatch";
          }
        } else {
          return "snapshot_mode_mismatch";
        }
        break;
      }
      case "request.done":
        if (event.payload?.mode !== mode) return "done_mode_mismatch";
        if (finalText === undefined) return "done_without_final_snapshot";
        if (event.payload?.final_text !== finalText) return "done_text_mismatch";
        terminal = true;
        break;
      case "request.cancelled":
        terminal = true;
        break;
      case "error":
        if (event.payload?.terminal === true) terminal = true;
        break;
      default:
        return "unsupported_lifecycle_event";
    }
  }
  return terminal ? null : "missing_terminal";
}

function validateRequestLifecycles(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.request_lifecycles);
  const vectors = readJson(file);
  for (const testCase of vectors?.cases ?? []) {
    const violation = lifecycleViolation(testCase.events ?? []);
    if (testCase.valid && violation) fail(`valid request lifecycle rejected (${testCase.name}): ${violation}`);
    if (!testCase.valid && violation !== testCase.expected_rule) {
      fail(`invalid request lifecycle ${testCase.name} produced ${violation ?? "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} cross-message request lifecycle vectors checked`);
}

function decodeAudioFrame(hex) {
  const frame = Buffer.from(hex, "hex");
  const errors = [];
  if (frame.length < 48) return { errors: ["message_too_short"] };
  const magic = frame.subarray(0, 4).toString("ascii");
  const version = frame.readUInt8(4);
  const kind = frame.readUInt8(5);
  const flags = frame.readUInt16BE(6);
  const headerLength = frame.readUInt16BE(8);
  const reserved16 = frame.readUInt16BE(10);
  const sequence = frame.readUInt32BE(12);
  const timestampUs = Number(frame.readBigUInt64BE(16));
  const payloadLength = frame.readUInt32BE(24);
  const reserved32 = frame.readUInt32BE(28);
  const requestHex = frame.subarray(32, 48).toString("hex");
  const requestId = `${requestHex.slice(0, 8)}-${requestHex.slice(8, 12)}-${requestHex.slice(12, 16)}-${requestHex.slice(16, 20)}-${requestHex.slice(20)}`;
  if (magic !== "MSVA") errors.push("invalid_magic");
  if (version !== 2) errors.push("unsupported_version");
  if (kind !== 1) errors.push("unsupported_kind");
  if (flags !== 0 || reserved16 !== 0 || reserved32 !== 0) errors.push("reserved_not_zero");
  if (headerLength !== 48) errors.push("invalid_header_length");
  if (frame.length !== headerLength + payloadLength) errors.push("message_length_mismatch");
  if (payloadLength === 0 || payloadLength % 2 !== 0) errors.push("invalid_payload_length");
  const samples = [];
  if (frame.length >= headerLength + payloadLength) {
    for (let offset = headerLength; offset < headerLength + payloadLength; offset += 2) samples.push(frame.readInt16LE(offset));
  }
  return { errors, kind, sequence, timestampUs, payloadLength, requestId, samples };
}

function encodeAudioFrame(decoded) {
  const payload = Buffer.alloc(decoded.samples.length * 2);
  decoded.samples.forEach((sample, index) => payload.writeInt16LE(sample, index * 2));
  const frame = Buffer.alloc(48 + payload.length);
  frame.write("MSVA", 0, "ascii");
  frame.writeUInt8(2, 4);
  frame.writeUInt8(1, 5);
  frame.writeUInt16BE(0, 6);
  frame.writeUInt16BE(48, 8);
  frame.writeUInt16BE(0, 10);
  frame.writeUInt32BE(decoded.sequence, 12);
  frame.writeBigUInt64BE(BigInt(decoded.timestampUs), 16);
  frame.writeUInt32BE(payload.length, 24);
  frame.writeUInt32BE(0, 28);
  Buffer.from(decoded.requestId.replaceAll("-", ""), "hex").copy(frame, 32);
  payload.copy(frame, 48);
  return frame.toString("hex");
}

function validateAudioVectors(manifest) {
  const file = path.resolve(path.dirname(manifestPath), manifest.vectors.binary_audio);
  const vectors = readJson(file);
  const streams = new Map();
  for (const testCase of vectors?.cases ?? []) {
    const decoded = decodeAudioFrame(testCase.frame_hex);
    if (testCase.valid) {
      if (decoded.errors.length) fail(`${testCase.name}: ${decoded.errors.join(", ")}`);
      for (const [key, actual] of Object.entries({
        kind: decoded.kind,
        sequence: decoded.sequence,
        timestamp_us: decoded.timestampUs,
        payload_length: decoded.payloadLength,
        samples: decoded.samples
      })) {
        if (JSON.stringify(actual) !== JSON.stringify(testCase.expected[key])) fail(`${testCase.name}: ${key} mismatch`);
      }
      if (decoded.requestId !== vectors.request_id) fail(`${testCase.name}: UUID byte order mismatch`);
      if (encodeAudioFrame(decoded) !== testCase.frame_hex) fail(`${testCase.name}: encode roundtrip mismatch`);
      if (testCase.stream) (streams.get(testCase.stream) ?? streams.set(testCase.stream, []).get(testCase.stream)).push(decoded);
    } else if (!decoded.errors.includes(testCase.expected_error)) {
      fail(`${testCase.name}: expected ${testCase.expected_error}, got ${decoded.errors.join(", ")}`);
    }
  }
  for (const [name, frames] of streams) {
    frames.sort((a, b) => a.sequence - b.sequence);
    let samplesBefore = 0;
    frames.forEach((frame, index) => {
      if (frame.sequence !== index) fail(`${name}: sequence is not contiguous`);
      const expectedTimestamp = Math.floor(samplesBefore * 1_000_000 / vectors.sample_rate);
      if (frame.timestampUs !== expectedTimestamp) fail(`${name}: timestamp_us mismatch`);
      samplesBefore += frame.samples.length;
    });
  }
  for (const commit of vectors?.commits ?? []) {
    const frames = [...(streams.get(commit.stream) ?? [])].sort((a, b) => a.sequence - b.sequence);
    const sampleCount = frames.reduce((total, frame) => total + frame.samples.length, 0);
    const canonical = {
      last_sequence: frames.length - 1,
      chunk_count: frames.length,
      sample_count: sampleCount,
      duration_ms: Math.ceil(sampleCount * 1000 / vectors.sample_rate)
    };
    const violation = JSON.stringify(canonical) === JSON.stringify(commit.statistics) ? null : "input_statistics_mismatch";
    if (commit.valid && violation) fail(`${commit.name}: canonical commit statistics mismatch`);
    if (!commit.valid && violation !== commit.expected_rule) {
      fail(`${commit.name}: produced ${violation ?? "no violation"}, expected ${commit.expected_rule}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} binary audio frames and ${vectors?.commits?.length ?? 0} commit statistics checked byte-for-byte`);
}

function validateMarkdownLinks() {
  const files = walk(v2Root, ".md");
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const file of files) {
    for (const match of readText(file).matchAll(pattern)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
        fail(`${path.relative(repoRoot, file)}: broken local link ${match[1]}`);
      }
    }
  }
  pass(`${files.length} Markdown files checked for local links`);
}

function validateSemanticText() {
  const ws = readText(path.join(v2Root, "docs", "WS_PROTOCOL_V2.md"));
  const http = readText(path.join(v2Root, "docs", "HTTP_API_V2.md"));
  const lifecycle = readText(path.join(v2Root, "docs", "request-lifecycle.md"));
  for (const required of ["长期连接", "空闲状态不得仅因没有请求而关闭连接", "一次性", "session_revoked", "不得恢复或重放活跃请求", "request_id_reused", "realtime_ticket_consumed", "原子锁定 success 终态", "唯一权威建连路径", "heartbeat_timeout_ms < heartbeat_interval_ms", "1002", "不自动重连"]) {
    if (!ws.includes(required)) fail(`WS semantics missing: ${required}`);
  }
  for (const required of ["/v2/auth/authorize", "/v2/auth/token", "code_challenge", "code_verifier", "系统默认浏览器", "注册", "/v2/quota", "/v2/realtime/tickets", "refresh token", "Keychain", "Idempotency-Key", "idempotency_result_expired", "defaults[mode]", "[from_ms, to_ms)"]) {
    if (!http.includes(required)) fail(`HTTP semantics missing: ${required}`);
  }
  for (const required of ["asr_only", "asr_llm", "临时文本区域", "final=true", "不得写入真实目标", "录音期间", "LLM delta", "stage 切换 snapshot"]) {
    if (!lifecycle.includes(required)) fail(`request lifecycle semantics missing: ${required}`);
  }
  for (const required of ["asr_credits_charged", "llm_credits_charged", "credits_charged = asr_credits_charged + llm_credits_charged"]) {
    if (!lifecycle.includes(required)) fail(`request lifecycle split billing semantics missing: ${required}`);
  }
  pass("long-lived connection, HTTP auth/quota, and temporary-text commit semantics checked");
}

const manifest = readJson(manifestPath);
if (!manifest) process.exit(1);
const validators = buildSchemaValidators(manifest);
await validateOpenApi();
validateMarkdownExamples(manifest, validators);
validateInvalidMessages(manifest, validators);
validateBrowserAuthorization(manifest);
validateAuthIdempotency(manifest);
validateSessionParameters(manifest);
validateModePipelines(manifest);
validateBillingUsage(manifest);
validateRequestLifecycles(manifest);
validateAudioVectors(manifest);
validateMarkdownLinks();
validateSemanticText();

if (failures.length) {
  console.error("MindSurf Voice v2 protocol validation failed:");
  failures.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log("MindSurf Voice v2 protocol validation passed:");
checks.forEach((message) => console.log(`- ${message}`));
