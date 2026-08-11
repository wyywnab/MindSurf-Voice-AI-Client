import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v2Root = path.join(repoRoot, "docs", "v2");
const failures = [];
const checks = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  checks.push(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
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

function resolvePointer(document, fragment) {
  if (!fragment || fragment === "#") return document;
  if (!fragment.startsWith("#/")) return undefined;
  return fragment
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], document);
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function schemaMessageTypes(schema) {
  const types = [];
  for (const option of schema?.oneOf ?? []) {
    const definition = resolvePointer(schema, option.$ref);
    let messageType;
    visit(definition, (node) => {
      if (typeof node?.properties?.type?.const === "string") messageType = node.properties.type.const;
    });
    if (messageType) types.push(messageType);
  }
  return types;
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function validateSchemas(manifest, manifestDir) {
  const schemaDir = path.join(v2Root, "schemas");
  const schemaFiles = walk(schemaDir, ".schema.json");
  const documents = new Map(schemaFiles.map((file) => [file, readJson(file)]));

  for (const [file, document] of documents) {
    if (!document) continue;
    if (document.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail(`${path.relative(repoRoot, file)}: must declare JSON Schema 2020-12`);
    }
    visit(document, (node) => {
      if (typeof node.$ref !== "string" || node.$ref.startsWith("http")) return;
      const hashIndex = node.$ref.indexOf("#");
      const relativeFile = hashIndex === -1 ? node.$ref : node.$ref.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? "" : node.$ref.slice(hashIndex);
      const targetFile = relativeFile ? path.resolve(path.dirname(file), relativeFile) : file;
      const targetDocument = documents.get(targetFile) ?? readJson(targetFile);
      if (!targetDocument) return;
      if (fragment && resolvePointer(targetDocument, fragment) === undefined) {
        fail(`${path.relative(repoRoot, file)}: unresolved schema ref ${node.$ref}`);
      }
    });
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const document of documents.values()) {
    if (document) ajv.addSchema(document);
  }

  const clientSchema = readJson(path.resolve(manifestDir, manifest.sources.client_schema));
  const serverSchema = readJson(path.resolve(manifestDir, manifest.sources.server_schema));
  let validators = null;
  try {
    validators = {
      client: ajv.getSchema(clientSchema.$id) ?? ajv.compile(clientSchema),
      server: ajv.getSchema(serverSchema.$id) ?? ajv.compile(serverSchema)
    };
  } catch (error) {
    fail(`JSON Schema compilation failed: ${error.message}`);
  }
  const clientTypes = schemaMessageTypes(clientSchema).sort();
  const serverTypes = schemaMessageTypes(serverSchema).sort();
  if (JSON.stringify(clientTypes) !== JSON.stringify([...manifest.required_client_message_types].sort())) {
    fail("client schema message types differ from test-vector manifest");
  }
  if (JSON.stringify(serverTypes) !== JSON.stringify([...manifest.required_server_message_types].sort())) {
    fail("server schema message types differ from test-vector manifest");
  }
  pass(`${schemaFiles.length} JSON Schema 2020-12 files compiled with formats and local refs`);
  return { messageTypes: new Set([...clientTypes, ...serverTypes]), validators };
}

async function validateOpenApi(manifest, manifestDir) {
  const file = path.resolve(manifestDir, manifest.sources.openapi);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  if (!text.startsWith("openapi: 3.1.")) fail("OpenAPI contract must use OpenAPI 3.1");

  const componentNames = new Map();
  let inComponents = false;
  let category = null;
  for (const line of lines) {
    if (line === "components:") {
      inComponents = true;
      continue;
    }
    if (!inComponents) continue;
    const categoryMatch = /^  ([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
    if (categoryMatch) {
      category = categoryMatch[1];
      componentNames.set(category, new Set());
      continue;
    }
    const nameMatch = /^    ([A-Za-z][A-Za-z0-9]*):(?:\s|$)/.exec(line);
    if (category && nameMatch) componentNames.get(category).add(nameMatch[1]);
  }

  for (const match of text.matchAll(/\$ref:\s*['"]?#\/components\/([^/]+)\/([^'"\s]+)['"]?/g)) {
    const [, refCategory, name] = match;
    if (!componentNames.get(refCategory)?.has(name)) {
      fail(`openapi: unresolved component ref ${refCategory}/${name}`);
    }
  }

  const paths = [...text.matchAll(/^  (\/v2\/[^:]+):\s*$/gm)].map((match) => match[1]);
  const operationIds = [...text.matchAll(/^      operationId:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (new Set(operationIds).size !== operationIds.length) fail("openapi: operationId values must be unique");
  if (paths.length !== 6 || operationIds.length !== 10) {
    fail(`openapi: expected 6 paths and 10 operations, got ${paths.length} and ${operationIds.length}`);
  }
  try {
    const api = await SwaggerParser.parse(file);
    const expectedOperationErrors = [
      ["/v2/voices", "get", "400", "ListVoicesBadRequest"],
      ["/v2/voices", "post", "400", "CreateVoiceBadRequest"],
      ["/v2/voices", "post", "403", "CreateVoiceForbidden"],
      ["/v2/voices", "post", "409", "CreateVoiceConflict"],
      ["/v2/voices/{voice_id}", "get", "404", "VoiceNotFound"],
      ["/v2/voices/{voice_id}", "patch", "400", "UpdateVoiceBadRequest"],
      ["/v2/voices/{voice_id}", "patch", "404", "VoiceNotFound"],
      ["/v2/voices/{voice_id}", "patch", "409", "UpdateVoiceConflict"],
      ["/v2/voices/{voice_id}", "delete", "404", "VoiceNotFound"],
      ["/v2/voices/{voice_id}/references", "post", "400", "CreateReferenceBadRequest"],
      ["/v2/voices/{voice_id}/references", "post", "404", "VoiceNotFound"],
      ["/v2/voices/{voice_id}/references", "post", "409", "CreateReferenceConflict"],
      ["/v2/voices/{voice_id}/references/{reference_id}", "get", "404", "VoiceReferenceNotFound"],
      ["/v2/voices/{voice_id}/references/{reference_id}", "delete", "404", "VoiceReferenceNotFound"],
      ["/v2/voices/{voice_id}/references/{reference_id}", "delete", "409", "DeleteReferenceConflict"],
      ["/v2/conversations/{conversation_id}", "delete", "409", "DeleteConversationConflict"]
    ];
    for (const [apiPath, method, status, responseName] of expectedOperationErrors) {
      const ref = api.paths?.[apiPath]?.[method]?.responses?.[status]?.$ref;
      if (ref !== `#/components/responses/${responseName}`) {
        fail(`openapi: ${method.toUpperCase()} ${apiPath} ${status} must use ${responseName}`);
      }
    }
    const schemas = api.components?.schemas ?? {};
    const listVoices = api.paths?.["/v2/voices"]?.get;
    const listParameterNames = (listVoices?.parameters ?? []).map((parameter) => parameter.name);
    if (listParameterNames.includes("limit") || listParameterNames.includes("cursor")) {
      fail("openapi: GET /v2/voices must not expose pagination parameters");
    }
    const voiceListData = schemas.VoiceListResponse?.properties?.data;
    if ((voiceListData?.required ?? []).includes("next_cursor") || voiceListData?.properties?.next_cursor) {
      fail("openapi: VoiceListResponse must return a complete non-paginated items array");
    }
    const pipelineFeatures = schemas.PipelineFeatures ?? {};
    if (!(pipelineFeatures.required ?? []).includes("outputs") ||
        pipelineFeatures.properties?.streaming_text || pipelineFeatures.properties?.streaming_audio) {
      fail("openapi: PipelineFeatures must use outputs.* supported/streaming capabilities");
    }
    const outputs = schemas.PipelineOutputs?.properties ?? {};
    if (!outputs.text || !outputs.audio) {
      fail("openapi: PipelineOutputs must define text and audio");
    }
    const pipeline = schemas.Pipeline ?? {};
    const pipelineKinds = pipeline.properties?.kind?.enum ?? [];
    if (!(pipeline.required ?? []).includes("kind") ||
        JSON.stringify(pipelineKinds) !== JSON.stringify(["native_audio", "cascade"])) {
      fail("openapi: Pipeline must require kind=native_audio|cascade independently of id");
    }
    if (pipeline.properties?.id?.enum || pipeline.properties?.id?.const) {
      fail("openapi: Pipeline id must remain an opaque string, not a kind enum");
    }
    const voiceCloningRules = JSON.stringify(schemas.VoiceCloningCapabilities?.allOf ?? []);
    if (!voiceCloningRules.includes('"asynchronous":{"const":true}')) {
      fail("openapi: supported voice cloning must be asynchronous in v2");
    }
    const createReference409 = JSON.stringify(schemas.CreateReferenceError409 ?? {});
    if (!createReference409.includes("emotion_reference_variants_unsupported")) {
      fail("openapi: create reference must expose emotion_reference_variants_unsupported");
    }
    const voiceRules = JSON.stringify(schemas.Voice?.allOf ?? []);
    for (const invariant of ["base_reference_id", "default_emotion", "supported_emotions"]) {
      if (!voiceRules.includes(invariant)) fail(`openapi: Voice state rules must constrain ${invariant}`);
    }
    if (!voiceRules.includes('"minContains":1') ||
        !voiceRules.includes('"speaker_verification":{"const":"pending"}')) {
      fail("openapi: a processing custom reference voice must expose its pending initial reference");
    }
    const processingReferenceRules = JSON.stringify(schemas.EmotionReferenceSummary?.allOf ?? []);
    if (!processingReferenceRules.includes('"status":{"const":"processing"}') ||
        !processingReferenceRules.includes('"speaker_verification":{"const":"pending"}')) {
      fail("openapi: processing emotion references must use speaker_verification=pending");
    }
    const pipelineEmotionDescription = schemas.PipelineFeatures?.properties?.emotion_control?.description ?? "";
    const voiceEmotionDescription = schemas.Voice?.properties?.emotion_control?.description ?? "";
    if (!pipelineEmotionDescription.includes("Voice") || !voiceEmotionDescription.includes("Pipeline")) {
      fail("openapi: Pipeline and Voice emotion_control compatibility must be explicit");
    }
    await SwaggerParser.validate(api);
  } catch (error) {
    fail(`OpenAPI 3.1 validation failed: ${error.message}`);
  }
  pass(`${paths.length} OpenAPI paths and ${operationIds.length} operations validated as OpenAPI 3.1`);
}

function validateMarkdownExamples(manifest, manifestDir, messageTypes, validators) {
  const wsFile = path.resolve(manifestDir, manifest.sources.ws_document);
  const text = fs.readFileSync(wsFile, "utf8");
  const examples = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const covered = new Set();
  for (const [index, match] of examples.entries()) {
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch (error) {
      fail(`${path.relative(repoRoot, wsFile)} JSON example ${index + 1}: ${error.message}`);
      continue;
    }
    if (typeof value.type !== "string") continue;
    covered.add(value.type);
    if (!messageTypes.has(value.type)) fail(`WS document example uses undeclared message type ${value.type}`);
    if (value.v !== 2 || !("request_id" in value) || !("payload" in value)) {
      fail(`WS document ${value.type} example is not a complete v2 envelope`);
    }
    const direction = value.type === "client.hello" || value.type === "session.pong" ||
      value.type === "request.start" || value.type === "input.commit" || value.type === "request.cancel"
      ? "client"
      : "server";
    const validator = validators?.[direction];
    if (validator && !validator(value)) {
      fail(`WS document ${value.type} example fails ${direction} schema: ${formatAjvErrors(validator.errors)}`);
    }
  }
  for (const type of messageTypes) {
    if (!covered.has(type)) fail(`WS document has no complete JSON example for ${type}`);
  }
  pass(`${covered.size} WebSocket message types covered by schema-valid documentation examples`);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidRuleMatches(testCase, messageTypes) {
  const message = testCase.message;
  switch (testCase.expected_rule) {
    case "request_id_must_be_uuid":
      return !uuidPattern.test(message.request_id ?? "");
    case "session_request_id_must_be_null":
      return message.request_id !== null;
    case "message_type_must_be_declared":
      return !messageTypes.has(message.type);
    case "payload_is_required":
      return !("payload" in message);
    case "dictation_conversation_id_must_be_null":
      return message.type === "request.start" && message.payload?.mode === "dictation" && message.payload?.conversation_id !== null;
    case "generation_must_be_channel_scoped": {
      const generation = message.payload?.generation;
      return generation && Object.keys(generation).some((key) => !["text", "audio"].includes(key));
    }
    case "conversation_active_must_be_retryable":
      return message.type === "error" && message.payload?.code === "conversation_active" && message.payload.retryable !== true;
    case "input_idle_timeout_stage_must_be_input":
      return message.type === "error" && message.payload?.code === "input_idle_timeout" && message.payload.stage !== "input";
    case "request_invalid_audio_frame_must_not_be_fatal":
      return message.type === "error" && message.payload?.code === "invalid_audio_frame" &&
        typeof message.request_id === "string" && message.payload.fatal !== false;
    case "session_invalid_audio_frame_must_be_fatal":
      return message.type === "error" && message.payload?.code === "invalid_audio_frame" &&
        message.request_id === null && message.payload.fatal !== true;
    case "terminal_request_error_stream_must_be_null":
      return message.type === "error" && typeof message.request_id === "string" &&
        message.payload?.terminal === true && message.payload.stream !== null;
    case "text_generation_requires_text_response":
      return message.type === "request.start" && message.payload?.response?.text === false &&
        Object.hasOwn(message.payload?.generation ?? {}, "text");
    case "authentication_error_must_be_session_fatal":
      return message.type === "error" && message.payload?.code?.startsWith("authentication_") &&
        (message.request_id !== null || message.payload.terminal !== false ||
          message.payload.retryable !== false || message.payload.fatal !== true);
    case "client_hello_requires_auth":
      return message.type === "client.hello" && !Object.hasOwn(message.payload ?? {}, "auth");
    case "request_protocol_error_must_be_terminal":
      return message.type === "error" && typeof message.request_id === "string" &&
        ["invalid_message", "unsupported_message_type"].includes(message.payload?.code) &&
        (message.payload.terminal !== true || message.payload.retryable !== false || message.payload.fatal !== false);
    case "session_protocol_error_must_be_fatal":
      return message.type === "error" && message.request_id === null &&
        ["invalid_message", "unsupported_message_type"].includes(message.payload?.code) &&
        (message.payload.terminal !== false || message.payload.retryable !== false || message.payload.fatal !== true);
    case "stream_error_must_not_be_retryable":
      return message.type === "error" && typeof message.payload?.stream === "string" &&
        message.payload.retryable !== false;
    case "audio_stream_error_code_must_match_stream":
      return message.type === "error" && message.payload?.stream === "audio" &&
        !["output_audio_failed", "output_audio_timeout", "request_timeout"].includes(message.payload.code);
    case "request_start_requires_capabilities_revision":
      return message.type === "request.start" &&
        !Object.hasOwn(message.payload ?? {}, "capabilities_revision");
    case "capabilities_stale_must_be_retryable":
      return message.type === "error" && message.payload?.code === "capabilities_stale" &&
        message.payload.retryable !== true;
    default:
      fail(`unknown invalid JSON fixture rule ${testCase.expected_rule}`);
      return false;
  }
}

function validateResolvedContractSemantics(manifest, manifestDir) {
  const client = readJson(path.resolve(manifestDir, manifest.sources.client_schema));
  const server = readJson(path.resolve(manifestDir, manifest.sources.server_schema));
  const request = readJson(path.resolve(manifestDir, "../schemas/common/request.schema.json"));
  const errors = readJson(path.resolve(manifestDir, "../schemas/common/errors.schema.json"));
  if (!client || !server || !request || !errors) return;

  const generation = request.$defs?.generation;
  if (!(client.$defs?.clientHelloPayload?.required ?? []).includes("auth")) {
    fail("client.hello must require Bearer auth");
  }
  if (client.$defs?.clientHelloPayload?.properties?.output_audio?.minItems !== undefined) {
    fail("client hello output_audio must allow an empty negotiated capability set");
  }
  if (generation?.additionalProperties !== false || !generation?.properties?.text || !generation?.properties?.audio) {
    fail("generation schema must use only text/audio channel namespaces");
  }
  if (client.$defs?.inputCommit?.allOf?.[1]?.properties?.payload?.properties?.duration_ms?.minimum !== 0) {
    fail("input.commit duration_ms must allow formula result 0");
  }
  if (server.$defs?.inputStatistics?.properties?.duration_ms?.minimum !== 0) {
    fail("input.committed duration_ms must allow formula result 0");
  }
  const stopAudio = server.$defs?.outputAudioDonePayload?.allOf?.[0]?.then?.properties;
  if (stopAudio?.duration_ms?.minimum !== 0) {
    fail("successful output.audio.done duration_ms must allow formula result 0");
  }
  const timeoutRequired = server.$defs?.timeouts?.required ?? [];
  if (!timeoutRequired.includes("input_idle_timeout_ms")) {
    fail("server hello timeouts must require input_idle_timeout_ms");
  }
  const acceptedRequired = server.$defs?.requestAcceptedPayload?.required ?? [];
  const startRequired = client.$defs?.requestStartPayload?.required ?? [];
  if (!startRequired.includes("capabilities_revision") || !acceptedRequired.includes("capabilities_revision")) {
    fail("request.start and request.accepted must require capabilities_revision");
  }
  if (!acceptedRequired.includes("language") || !server.$defs?.requestAcceptedPayload?.properties?.generation) {
    fail("request.accepted must carry language and support generation echo");
  }
  const errorCodes = errors.$defs?.errorCode?.enum ?? [];
  for (const code of ["input_idle_timeout", "conversation_active", "capabilities_stale"]) {
    if (!errorCodes.includes(code)) fail(`error schema missing ${code}`);
  }
  const limits = server.$defs?.limits?.properties ?? {};
  if (limits.max_json_bytes?.const !== 65536 || limits.max_binary_bytes?.minimum !== 50) {
    fail("server hello limits must fix JSON at 65536 bytes and allow no binary maximum below 50 bytes");
  }
  const acceptedRulesText = JSON.stringify(server.$defs?.requestAcceptedPayload?.allOf ?? []);
  const errorRulesText = JSON.stringify(server.$defs?.errorMessage?.allOf ?? []);
  for (const code of ["conversation_active", "input_idle_timeout", "invalid_audio_frame"]) {
    if (acceptedRulesText.includes(code) || !errorRulesText.includes(code)) {
      fail(`${code} constraints must live under errorMessage, not requestAcceptedPayload`);
    }
  }
  const startRulesText = JSON.stringify(client.$defs?.requestStartPayload?.allOf ?? []);
  const acceptedRules = JSON.stringify(server.$defs?.requestAcceptedPayload?.allOf ?? []);
  for (const rules of [startRulesText, acceptedRules]) {
    if (rules.includes('"pipeline":{"const":"native_audio"}') ||
        rules.includes('"pipeline":{"const":"cascade"}')) {
      fail("WebSocket schemas must not infer Pipeline kind from an opaque pipeline ID");
    }
  }
  for (const channel of ["text", "audio"]) {
    if (!startRulesText.includes(`\"required\":[\"${channel}\"]`) ||
        !acceptedRules.includes(`\"required\":[\"${channel}\"]`)) {
      fail(`generation.${channel} must be prohibited when response.${channel}=false`);
    }
  }
  const errorPolicyText = JSON.stringify(errors.$defs?.errorPayload?.allOf ?? []);
  for (const code of ["pipeline_unavailable", "capabilities_stale", "rate_limited", "unsupported_model", "voice_not_ready"]) {
    if (!errorPolicyText.includes(code)) fail(`error retry policy missing ${code}`);
  }
  const errorPolicies = errors.$defs?.errorPayload?.allOf ?? [];
  const expectedStages = new Map([
    ["authentication_failed", "authentication"],
    ["permission_denied", "authorization"],
    ["rate_limited", "quota"],
    ["protocol_version_mismatch", "session"],
    ["pipeline_unavailable", "routing"],
    ["capabilities_stale", "routing"],
    ["input_empty", "input"],
    ["transcription_failed", "transcription"],
    ["generation_failed", "generation"],
    ["output_audio_failed", "output"],
    ["invalid_message", "protocol"]
  ]);
  for (const [code, expectedStage] of expectedStages) {
    const policy = errorPolicies.find((rule) => {
      const codeRule = rule.if?.properties?.code;
      return codeRule?.const === code || codeRule?.enum?.includes(code);
    });
    if (policy?.then?.properties?.stage?.const !== expectedStage) {
      fail(`error ${code} must fix stage=${expectedStage}`);
    }
  }
  const requestScopeRules = JSON.stringify(server.$defs?.errorMessage?.allOf ?? []);
  for (const code of ["permission_denied", "pipeline_unavailable", "capabilities_stale", "request_timeout", "conversation_not_found"]) {
    if (!requestScopeRules.includes(code)) fail(`error ${code} must be request scoped`);
  }
  if (!requestScopeRules.includes('"retryable":{"const":false}') ||
      !requestScopeRules.includes("unsupported_message_type")) {
    fail("stream errors and protocol-message errors must have deterministic retry policy");
  }
  if (server.$defs?.outputAudioStartPayload?.allOf?.[1]?.properties?.voice?.type?.[1] !== "null") {
    fail("output.audio.start voice must allow null for voice_control=none");
  }
  pass("resolved v2 decisions reflected in JSON Schemas");
}

function validateHttpDocumentation() {
  const file = path.join(v2Root, "docs", "HTTP_API_V2.md");
  const text = fs.readFileSync(file, "utf8");
  const examples = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  let capabilityExample = null;
  for (const [index, match] of examples.entries()) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.data?.protocol_version === 2) capabilityExample = value.data;
    } catch (error) {
      fail(`docs/v2/docs/HTTP_API_V2.md JSON example ${index + 1}: ${error.message}`);
    }
  }
  if (!capabilityExample) {
    fail("HTTP document must contain a parseable capabilities example");
    return;
  }
  for (const pipeline of capabilityExample.pipelines ?? []) {
    if (!["native_audio", "cascade"].includes(pipeline.kind)) {
      fail(`capabilities example ${pipeline.id} must declare a supported Pipeline kind`);
    }
    if (!Number.isInteger(pipeline.max_recording_ms) || pipeline.max_recording_ms <= 0) {
      fail(`capabilities example ${pipeline.id} must declare a positive integer max_recording_ms`);
    }
    for (const channel of ["text", "audio"]) {
      const output = pipeline.features?.outputs?.[channel];
      if (typeof output?.supported !== "boolean" || typeof output?.streaming !== "boolean") {
        fail(`capabilities example ${pipeline.id}.outputs.${channel} must declare supported and streaming`);
      }
      if (output?.supported === false && output.streaming !== false) {
        fail(`capabilities example ${pipeline.id}.outputs.${channel} cannot stream when unsupported`);
      }
    }
    const audioOutput = pipeline.features?.outputs?.audio;
    if (audioOutput?.supported === true && audioOutput.streaming !== true) {
      fail(`capabilities example ${pipeline.id}.outputs.audio must stream when supported`);
    }
    for (const channel of ["text", "audio"]) {
      const controls = pipeline.features?.generation_controls?.[channel] ?? {};
      for (const [name, control] of Object.entries(controls)) {
        if (!(control.minimum <= control.default && control.default <= control.maximum)) {
          fail(`capabilities example ${pipeline.id}.${channel}.${name} must satisfy minimum <= default <= maximum`);
        }
      }
    }
  }
  if (/"code":\s*"invalid_reference_audio"/.test(text.slice(0, text.indexOf("## 2.4")))) {
    fail("HTTP synchronous error example must not use asynchronous invalid_reference_audio failure code");
  }
  pass(`${examples.length} HTTP JSON examples parsed and generation-control bounds checked`);
}

function pipelineKindRequestViolation(capabilities, request) {
  if (request.capabilities_revision !== capabilities.revision) {
    return "capabilities_revision_must_match_before_pipeline_lookup";
  }
  const pipeline = capabilities.pipelines?.find((candidate) => candidate.id === request.pipeline);
  if (!pipeline) return "pipeline_must_exist_in_revision";
  if (!(pipeline.modes ?? []).includes(request.mode)) return "pipeline_mode_must_be_supported";

  const selection = request.selection ?? {};
  const nonEmpty = (value) => typeof value === "string" && value.length > 0;
  if (pipeline.kind === "native_audio") {
    if (request.mode !== "assistant" || !nonEmpty(selection.model) ||
        selection.asr !== null || selection.llm !== null || selection.tts !== null) {
      return "native_selection_shape";
    }
    return null;
  }
  if (pipeline.kind === "cascade") {
    if (selection.model !== null || !nonEmpty(selection.asr)) {
      return "cascade_selection_shape";
    }
    if (request.mode === "dictation") {
      if (selection.llm !== null || selection.tts !== null) {
        return "cascade_dictation_selection_shape";
      }
      return null;
    }
    if (!nonEmpty(selection.llm)) return "cascade_assistant_requires_llm";
    if (request.response?.audio === true && !nonEmpty(selection.tts)) {
      return "cascade_assistant_audio_requires_tts";
    }
    if (request.response?.audio === false && selection.tts !== null) {
      return "cascade_text_assistant_tts_must_be_null";
    }
    return null;
  }
  return "unsupported_pipeline_kind";
}

function validatePipelineKindRequests(manifest, manifestDir) {
  const file = path.resolve(manifestDir, manifest.vectors.pipeline_kind_requests);
  const vectors = readJson(file);
  if (!vectors) return;
  const capabilities = vectors.capabilities ?? {};
  const ids = (capabilities.pipelines ?? []).map((pipeline) => pipeline.id);
  if (new Set(ids).size !== ids.length) fail("pipeline kind vectors must use unique opaque IDs");
  const kinds = (capabilities.pipelines ?? []).map((pipeline) => pipeline.kind);
  if (kinds.filter((kind) => kind === "cascade").length < 2) {
    fail("pipeline kind vectors must prove that multiple IDs can share one kind");
  }
  for (const testCase of vectors.cases ?? []) {
    const violation = pipelineKindRequestViolation(capabilities, testCase.request ?? {});
    if (testCase.valid && violation) {
      fail(`valid pipeline-kind request rejected (${testCase.name}): ${violation}`);
    }
    if (!testCase.valid && violation !== testCase.expected_rule) {
      fail(`invalid pipeline-kind request ${testCase.name} produced ${violation ?? "no violation"}, expected ${testCase.expected_rule}`);
    }
  }
  pass(`${vectors.cases?.length ?? 0} cross-resource Pipeline kind request vectors checked`);
}

function repairedInvalidMessage(testCase) {
  const repaired = structuredClone(testCase.message);
  switch (testCase.expected_rule) {
    case "request_id_must_be_uuid":
      repaired.request_id = "00112233-4455-6677-8899-aabbccddeeff";
      break;
    case "session_request_id_must_be_null":
      repaired.request_id = null;
      break;
    case "message_type_must_be_declared":
      repaired.type = "request.cancel";
      break;
    case "payload_is_required":
      repaired.payload = { last_sequence: 0, frame_count: 1, sample_count: 320, duration_ms: 20 };
      break;
    case "dictation_conversation_id_must_be_null":
      repaired.payload.conversation_id = null;
      break;
    case "generation_must_be_channel_scoped":
      delete repaired.payload.generation.temperature;
      break;
    case "conversation_active_must_be_retryable":
      repaired.payload.retryable = true;
      break;
    case "input_idle_timeout_stage_must_be_input":
      repaired.payload.stage = "input";
      break;
    case "request_invalid_audio_frame_must_not_be_fatal":
      repaired.payload.fatal = false;
      break;
    case "session_invalid_audio_frame_must_be_fatal":
      repaired.payload.fatal = true;
      break;
    case "terminal_request_error_stream_must_be_null":
      repaired.payload.stream = null;
      break;
    case "text_generation_requires_text_response":
      repaired.payload.response.text = true;
      break;
    case "authentication_error_must_be_session_fatal":
      repaired.payload.fatal = true;
      break;
    case "client_hello_requires_auth":
      repaired.payload.auth = { scheme: "bearer", token: "development-token" };
      break;
    case "request_protocol_error_must_be_terminal":
      repaired.payload.terminal = true;
      break;
    case "session_protocol_error_must_be_fatal":
      repaired.payload.fatal = true;
      break;
    case "stream_error_must_not_be_retryable":
      repaired.payload.retryable = false;
      break;
    case "audio_stream_error_code_must_match_stream":
      repaired.payload.code = "output_audio_failed";
      repaired.payload.stage = "output";
      break;
    case "request_start_requires_capabilities_revision":
      repaired.payload.capabilities_revision = "cap_test_1";
      break;
    case "capabilities_stale_must_be_retryable":
      repaired.payload.retryable = true;
      break;
    default:
      return null;
  }
  return repaired;
}

function validateInvalidJson(manifest, manifestDir, messageTypes, validators) {
  const file = path.resolve(manifestDir, manifest.vectors.invalid_json);
  const vectors = readJson(file);
  for (const testCase of vectors?.cases ?? []) {
    if (!invalidRuleMatches(testCase, messageTypes)) {
      fail(`invalid JSON fixture did not violate its expected rule: ${testCase.name}`);
    }
    const direction = testCase.direction ?? "client";
    const validator = validators?.[direction];
    if (validator && validator(testCase.message)) {
      fail(`invalid JSON fixture unexpectedly passed ${direction} schema: ${testCase.name}`);
    }
    const repaired = repairedInvalidMessage(testCase);
    if (validator && repaired && !validator(repaired)) {
      fail(`repairing only the target rule did not make fixture valid (${testCase.name}): ${formatAjvErrors(validator.errors)}`);
    }
  }
  pass(`${vectors?.cases?.length ?? 0} negative JSON vectors rejected, with target-only repairs accepted`);
}

function decodeAudioFrame(frame) {
  const errors = [];
  if (frame.length < 48) return { errors: ["message_too_short"] };
  const magic = frame.subarray(0, 4).toString("ascii");
  const version = frame.readUInt8(4);
  const kind = frame.readUInt8(5);
  const flags = frame.readUInt16BE(6);
  const headerLength = frame.readUInt16BE(8);
  const reserved1 = frame.readUInt16BE(10);
  const sequence = frame.readUInt32BE(12);
  const timestampUs = Number(frame.readBigUInt64BE(16));
  const payloadLength = frame.readUInt32BE(24);
  const reserved2 = frame.readUInt32BE(28);
  const requestIdHex = frame.subarray(32, 48).toString("hex");
  const requestId = `${requestIdHex.slice(0, 8)}-${requestIdHex.slice(8, 12)}-${requestIdHex.slice(12, 16)}-${requestIdHex.slice(16, 20)}-${requestIdHex.slice(20)}`;
  if (magic !== "MSVA") errors.push("invalid_magic");
  if (version !== 2) errors.push("unsupported_version");
  if (![1, 2].includes(kind)) errors.push("invalid_kind");
  if (flags !== 0 || reserved1 !== 0 || reserved2 !== 0) errors.push("reserved_field_nonzero");
  if (headerLength !== 48) errors.push("invalid_header_length");
  if (frame.length !== headerLength + payloadLength) errors.push("message_length_mismatch");
  if (payloadLength === 0 || payloadLength % 2 !== 0) errors.push("invalid_payload_length");
  const payload = frame.subarray(48);
  const samples = [];
  if (errors.length === 0) {
    for (let offset = 0; offset < payload.length; offset += 2) samples.push(payload.readInt16LE(offset));
  }
  return { errors, kind, sequence, timestampUs, payloadLength, requestId, samples };
}

function encodeAudioFrame(frame) {
  const payload = Buffer.alloc(frame.samples.length * 2);
  frame.samples.forEach((sample, index) => payload.writeInt16LE(sample, index * 2));
  const encoded = Buffer.alloc(48 + payload.length);
  encoded.write("MSVA", 0, "ascii");
  encoded.writeUInt8(2, 4);
  encoded.writeUInt8(frame.kind, 5);
  encoded.writeUInt16BE(0, 6);
  encoded.writeUInt16BE(48, 8);
  encoded.writeUInt16BE(0, 10);
  encoded.writeUInt32BE(frame.sequence, 12);
  encoded.writeBigUInt64BE(BigInt(frame.timestampUs), 16);
  encoded.writeUInt32BE(payload.length, 24);
  encoded.writeUInt32BE(0, 28);
  Buffer.from(frame.requestId.replaceAll("-", ""), "hex").copy(encoded, 32);
  payload.copy(encoded, 48);
  return encoded;
}

function validateBinary(manifest, manifestDir) {
  const file = path.resolve(manifestDir, manifest.vectors.binary_audio);
  const vectors = readJson(file);
  const streams = new Map();
  for (const testCase of vectors?.cases ?? []) {
    if (!/^(?:[0-9a-f]{2})+$/i.test(testCase.frame_hex)) {
      fail(`binary fixture is not even-length hexadecimal: ${testCase.name}`);
      continue;
    }
    const original = Buffer.from(testCase.frame_hex, "hex");
    const decoded = decodeAudioFrame(original);
    if (testCase.valid) {
      if (decoded.errors.length) fail(`valid binary fixture rejected (${testCase.name}): ${decoded.errors.join(", ")}`);
      const expected = testCase.expected;
      for (const [key, actual] of Object.entries({
        kind: decoded.kind,
        sequence: decoded.sequence,
        timestamp_us: decoded.timestampUs,
        payload_length: decoded.payloadLength,
        samples: decoded.samples
      })) {
        if (JSON.stringify(actual) !== JSON.stringify(expected[key])) {
          fail(`${testCase.name}: decoded ${key} differs from expected`);
        }
      }
      if (decoded.requestId !== vectors.request_id) fail(`${testCase.name}: UUID byte order mismatch`);
      if (!encodeAudioFrame(decoded).equals(original)) fail(`${testCase.name}: decode/encode is not byte-for-byte stable`);
      if (testCase.direction === "client_to_server" && decoded.kind !== 1) fail(`${testCase.name}: client frame must use INPUT_PCM`);
      if (testCase.direction === "server_to_client" && decoded.kind !== 2) fail(`${testCase.name}: server frame must use OUTPUT_PCM`);
      const stream = streams.get(testCase.stream) ?? [];
      stream.push({ ...decoded, sampleCount: decoded.samples.length });
      streams.set(testCase.stream, stream);
    } else if (!decoded.errors.includes(testCase.expected_error)) {
      fail(`invalid binary fixture ${testCase.name} did not produce ${testCase.expected_error}`);
    }
  }

  for (const [name, frames] of streams) {
    frames.sort((a, b) => a.sequence - b.sequence);
    let samplesBefore = 0;
    const sampleRate = frames[0]?.kind === 1 ? 16000 : null;
    for (const [index, frame] of frames.entries()) {
      if (frame.sequence !== index) fail(`${name}: sequence is not contiguous from zero`);
      if (sampleRate && frame.timestampUs !== Math.floor(samplesBefore * 1_000_000 / sampleRate)) {
        fail(`${name}: timestamp_us is inconsistent with preceding samples`);
      }
      samplesBefore += frame.sampleCount;
    }
  }
  pass(`${vectors?.cases?.length ?? 0} binary audio vectors decoded and checked byte-for-byte`);
}

function validateMarkdownLinks() {
  const markdownFiles = walk(v2Root, ".md");
  for (const file of markdownFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      target = decodeURIComponent(target.split("#", 1)[0]);
      if (target && !fs.existsSync(path.resolve(path.dirname(file), target))) {
        fail(`${path.relative(repoRoot, file)}: broken local link ${match[1]}`);
      }
    }
  }
  pass(`${markdownFiles.length} Markdown files with resolvable local links`);
}

function validateCrossDocumentDecisions() {
  const ws = fs.readFileSync(path.join(v2Root, "docs", "WS_PROTOCOL_V2.md"), "utf8");
  const conversations = fs.readFileSync(path.join(v2Root, "docs", "conversations.md"), "utf8");
  const http = fs.readFileSync(path.join(v2Root, "docs", "HTTP_API_V2.md"), "utf8");
  for (const value of ["supported", "unvalidated", "unsupported"]) {
    if (!conversations.includes(`\`${value}\``)) {
      fail(`conversation interruption semantics must define ${value}`);
    }
  }
  if (!ws.includes("capabilities_revision") || !ws.includes("capabilities_stale")) {
    fail("WS documentation must define capabilities revision binding and stale rejection");
  }
  if (!http.includes("outputs.text.supported") || !http.includes("outputs.audio.supported")) {
    fail("HTTP documentation must define deterministic text/audio output request gates");
  }
  if (!http.includes("不透明业务配置 ID") || !http.includes("Pipeline `kind`") ||
      !ws.includes("ID→kind 映射")) {
    fail("HTTP and WS documentation must separate opaque Pipeline IDs from Pipeline kind");
  }
  if (!http.includes("emotion_reference_variants_unsupported") ||
      !http.includes("base_reference_id=null")) {
    fail("HTTP documentation must define voice cloning gates and initial voice state transitions");
  }
  if (!http.includes("同一原子串行化边界") || !http.includes("同步校验失败") ||
      !http.includes("初始或新增参考固定使用该值")) {
    fail("HTTP documentation must define atomic idempotency and initial-reference pending semantics");
  }
  if (!/所有\s+可用 Pipeline/.test(ws) || !ws.includes("emotion_control` 不匹配") ||
      !/客户端可以\s+声明空集或任意子集/.test(ws)) {
    fail("WS documentation must define global recording limits, emotion compatibility, and optional output formats");
  }
  pass("cross-document capability, interruption, and voice-state decisions checked");
}

const manifestFile = path.join(v2Root, "test-vectors", "manifest.json");
const manifestDir = path.dirname(manifestFile);
const manifest = readJson(manifestFile);
if (!manifest) process.exit(1);
if (manifest.protocol_version !== 2) fail("test-vector manifest protocol_version must be 2");

const { messageTypes, validators } = validateSchemas(manifest, manifestDir);
validateResolvedContractSemantics(manifest, manifestDir);
await validateOpenApi(manifest, manifestDir);
validateMarkdownExamples(manifest, manifestDir, messageTypes, validators);
validateInvalidJson(manifest, manifestDir, messageTypes, validators);
validateHttpDocumentation();
validatePipelineKindRequests(manifest, manifestDir);
validateBinary(manifest, manifestDir);
validateMarkdownLinks();
validateCrossDocumentDecisions();

if (failures.length) {
  console.error("MindSurf Voice v2 protocol validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("MindSurf Voice v2 protocol validation passed:");
for (const check of checks) console.log(`- ${check}`);
