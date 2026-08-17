import type {
  AuthData,
  Capabilities,
  GenerationControl,
  NamedOption,
  PipelineCapability,
  Quota,
  ResourceUsage,
  RealtimeTicket,
  UsageEntry,
  VoiceModeV2,
  VoiceUser,
} from "../../types/httpApi";

export class InvalidApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiResponseError";
  }
}

export function parseAuthData(value: unknown): AuthData {
  const data = record(value, "auth data");
  exactKeys(data, ["tokens", "user"], "auth data");
  const tokens = record(data.tokens, "tokens");
  exactKeys(
    tokens,
    ["token_type", "access_token", "expires_in", "refresh_token", "refresh_expires_in"],
    "tokens",
  );
  if (tokens.token_type !== "Bearer") invalid("token_type");
  return {
    tokens: {
      token_type: "Bearer",
      access_token: nonEmpty(tokens.access_token, "access_token"),
      expires_in: positiveInteger(tokens.expires_in, "expires_in"),
      refresh_token: nonEmpty(tokens.refresh_token, "refresh_token"),
      refresh_expires_in: positiveInteger(
        tokens.refresh_expires_in,
        "refresh_expires_in",
      ),
    },
    user: parseUser(data.user),
  };
}

export function parseUser(value: unknown): VoiceUser {
  const item = record(value, "user");
  exactKeys(
    item,
    ["user_id", "display_name", "login", "status", "plan", "created_at_ms"],
    "user",
  );
  if (item.status !== "active" && item.status !== "suspended") invalid("user.status");
  return {
    user_id: uuid(item.user_id, "user.user_id"),
    display_name: nonEmpty(item.display_name, "user.display_name"),
    login: nonEmpty(item.login, "user.login"),
    status: item.status,
    plan: nonEmpty(item.plan, "user.plan"),
    created_at_ms: nonNegativeInteger(item.created_at_ms, "user.created_at_ms"),
  };
}

export function parseQuota(value: unknown): Quota {
  const item = record(value, "quota");
  exactKeys(item, ["plan", "pricing_revision", "period", "credits", "usage"], "quota");
  const period = record(item.period, "quota.period");
  exactKeys(period, ["starts_at_ms", "ends_at_ms"], "quota.period");
  const credits = record(item.credits, "quota.credits");
  exactKeys(credits, ["limit", "used", "reserved", "remaining"], "quota.credits");
  const parsedCredits = {
    limit: nonNegativeInteger(credits.limit, "credits.limit"),
    used: nonNegativeInteger(credits.used, "credits.used"),
    reserved: nonNegativeInteger(credits.reserved, "credits.reserved"),
    remaining: nonNegativeInteger(credits.remaining, "credits.remaining"),
  };
  const usage = parseResourceUsage(item.usage, true);
  if (
    parsedCredits.remaining !==
      Math.max(parsedCredits.limit - parsedCredits.used - parsedCredits.reserved, 0) ||
    parsedCredits.used !== usage.credits_charged
  )
    invalid("quota credits invariant");
  return {
    plan: nonEmpty(item.plan, "quota.plan"),
    pricing_revision: nonEmpty(item.pricing_revision, "quota.pricing_revision"),
    period: {
      starts_at_ms: nonNegativeInteger(period.starts_at_ms, "period.starts_at_ms"),
      ends_at_ms: nonNegativeInteger(period.ends_at_ms, "period.ends_at_ms"),
    },
    credits: parsedCredits,
    usage,
  };
}

export function parseUsageList(value: unknown) {
  const data = record(value, "usage list");
  exactKeys(data, ["items", "next_cursor"], "usage list");
  if (!Array.isArray(data.items)) invalid("usage.items");
  if (data.next_cursor !== null && typeof data.next_cursor !== "string") {
    invalid("usage.next_cursor");
  }
  return {
    items: data.items.map(parseUsageEntry),
    next_cursor: data.next_cursor as string | null,
  };
}

export function parseRealtimeTicket(value: unknown): RealtimeTicket {
  const data = record(value, "realtime ticket");
  exactKeys(
    data,
    ["ticket", "expires_at_ms", "websocket_path", "subprotocol"],
    "realtime ticket",
  );
  const ticket = nonEmpty(data.ticket, "realtime ticket.ticket");
  const websocketPath = nonEmpty(data.websocket_path, "realtime ticket.websocket_path");
  if (
    ticket.length < 32 ||
    !/^\/[^/].*/.test(websocketPath) ||
    data.subprotocol !== "mindsurf.voice.v2"
  ) {
    invalid("realtime ticket");
  }
  return {
    ticket,
    expires_at_ms: nonNegativeInteger(
      data.expires_at_ms,
      "realtime ticket.expires_at_ms",
    ),
    websocket_path: websocketPath,
    subprotocol: "mindsurf.voice.v2",
  };
}

export function parseCapabilities(value: unknown): Capabilities {
  const data = record(value, "capabilities");
  exactKeys(
    data,
    [
      "protocol_version",
      "revision",
      "realtime",
      "modes",
      "pipelines",
      "asr_options",
      "llm_options",
      "recognition_languages",
      "defaults",
    ],
    "capabilities",
  );
  if (data.protocol_version !== 2) invalid("capabilities.protocol_version");
  const modes = uniqueStrings(data.modes, "capabilities.modes").map(mode);
  if (modes.length !== 2 || !modes.includes("asr_only") || !modes.includes("asr_llm")) {
    invalid("capabilities.modes");
  }
  const realtime = record(data.realtime, "capabilities.realtime");
  exactKeys(
    realtime,
    ["websocket_path", "ticket_path", "subprotocol", "persistent"],
    "realtime",
  );
  if (
    typeof realtime.websocket_path !== "string" ||
    !/^\/[^/].*/.test(realtime.websocket_path) ||
    realtime.ticket_path !== "/v2/realtime/tickets" ||
    realtime.subprotocol !== "mindsurf.voice.v2" ||
    realtime.persistent !== true
  )
    invalid("capabilities.realtime");

  const asrOptions = namedOptions(data.asr_options, "asr_options");
  const llmOptions = namedOptions(data.llm_options, "llm_options");
  const asrIds = new Set(asrOptions.map(({ id }) => id));
  const llmIds = new Set(llmOptions.map(({ id }) => id));
  if (!Array.isArray(data.pipelines) || data.pipelines.length === 0)
    invalid("pipelines");
  const pipelines = data.pipelines.map((item, index) =>
    parsePipeline(item, `pipelines[${index}]`, asrIds, llmIds),
  );
  assertUnique(
    pipelines.map(({ id }) => id),
    "pipeline ids",
  );
  const pipelineById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const defaults = record(data.defaults, "defaults");
  exactKeys(defaults, ["asr_only", "asr_llm"], "defaults");
  const parsedDefaults = {
    asr_only: parseDefault(defaults.asr_only, "asr_only", pipelineById),
    asr_llm: parseDefault(defaults.asr_llm, "asr_llm", pipelineById),
  };
  return {
    protocol_version: 2,
    revision: nonEmpty(data.revision, "capabilities.revision"),
    realtime: {
      websocket_path: realtime.websocket_path,
      ticket_path: "/v2/realtime/tickets",
      subprotocol: "mindsurf.voice.v2",
      persistent: true,
    },
    modes,
    pipelines,
    asr_options: asrOptions,
    llm_options: llmOptions,
    recognition_languages: uniqueStrings(
      data.recognition_languages,
      "recognition_languages",
    ),
    defaults: parsedDefaults,
  };
}

function parsePipeline(
  value: unknown,
  label: string,
  asrIds: Set<string>,
  llmIds: Set<string>,
): PipelineCapability {
  const item = record(value, label);
  exactKeys(
    item,
    [
      "id",
      "name",
      "description",
      "modes",
      "max_recording_ms",
      "asr_options",
      "llm_options",
      "generation_controls",
    ],
    label,
  );
  const modes = uniqueStrings(item.modes, `${label}.modes`).map(mode);
  const asrOptions = uniqueStrings(item.asr_options, `${label}.asr_options`);
  const llmOptions = uniqueStrings(item.llm_options, `${label}.llm_options`);
  if (!modes.length) invalid(`${label}.modes`);
  if (!asrOptions.length || asrOptions.some((id) => !asrIds.has(id)))
    invalid(`${label}.asr_options`);
  if (llmOptions.some((id) => !llmIds.has(id))) invalid(`${label}.llm_options`);
  if (modes.includes("asr_llm") && llmOptions.length === 0)
    invalid(`${label}.llm_options`);
  const controls = record(item.generation_controls, `${label}.generation_controls`);
  const generationControls = Object.fromEntries(
    Object.entries(controls).map(([key, control]) => [
      key,
      parseControl(control, `${label}.${key}`),
    ]),
  );
  return {
    id: nonEmpty(item.id, `${label}.id`),
    name: nonEmpty(item.name, `${label}.name`),
    description: string(item.description, `${label}.description`),
    modes,
    max_recording_ms: positiveInteger(
      item.max_recording_ms,
      `${label}.max_recording_ms`,
    ),
    asr_options: asrOptions,
    llm_options: llmOptions,
    generation_controls: generationControls,
  };
}

function parseDefault(
  value: unknown,
  requestedMode: VoiceModeV2,
  pipelineById: Map<string, PipelineCapability>,
) {
  const item = record(value, `defaults.${requestedMode}`);
  exactKeys(item, ["pipeline", "selection"], `defaults.${requestedMode}`);
  const pipelineId = nonEmpty(item.pipeline, `defaults.${requestedMode}.pipeline`);
  const pipeline = pipelineById.get(pipelineId);
  if (!pipeline || !pipeline.modes.includes(requestedMode))
    invalid(`defaults.${requestedMode}.pipeline`);
  const selection = record(item.selection, `defaults.${requestedMode}.selection`);
  exactKeys(selection, ["asr", "llm"], `defaults.${requestedMode}.selection`);
  const asr = nonEmpty(selection.asr, `defaults.${requestedMode}.selection.asr`);
  if (!pipeline.asr_options.includes(asr))
    invalid(`defaults.${requestedMode}.selection.asr`);
  const llm =
    selection.llm === null
      ? null
      : nonEmpty(selection.llm, `defaults.${requestedMode}.selection.llm`);
  if (
    requestedMode === "asr_only"
      ? llm !== null
      : llm === null || !pipeline.llm_options.includes(llm)
  ) {
    invalid(`defaults.${requestedMode}.selection.llm`);
  }
  return { pipeline: pipelineId, selection: { asr, llm } };
}

function parseControl(value: unknown, label: string): GenerationControl {
  const item = record(value, label);
  exactKeys(item, ["type", "minimum", "maximum", "default"], label);
  if (item.type !== "number" && item.type !== "integer") invalid(`${label}.type`);
  for (const key of ["minimum", "maximum", "default"] as const) {
    if (typeof item[key] !== "number" || !Number.isFinite(item[key]))
      invalid(`${label}.${key}`);
    if (item.type === "integer" && !Number.isInteger(item[key]))
      invalid(`${label}.${key}`);
  }
  const minimum = item.minimum as number;
  const maximum = item.maximum as number;
  const defaultValue = item.default as number;
  if (minimum > defaultValue || defaultValue > maximum) invalid(label);
  return { type: item.type, minimum, maximum, default: defaultValue };
}

function parseUsageEntry(value: unknown): UsageEntry {
  const item = record(value, "usage item");
  exactKeys(
    item,
    [
      "request_id",
      "mode",
      "settled_at_ms",
      "pricing_revision",
      "input_audio_ms",
      "llm_input_tokens",
      "llm_output_tokens",
      "asr_credits_charged",
      "llm_credits_charged",
      "credits_charged",
    ],
    "usage item",
  );
  return {
    request_id: uuid(item.request_id, "usage.request_id"),
    mode: mode(item.mode),
    settled_at_ms: nonNegativeInteger(item.settled_at_ms, "usage.settled_at_ms"),
    pricing_revision: nonEmpty(item.pricing_revision, "usage.pricing_revision"),
    ...parseResourceUsage(item),
  };
}

function parseResourceUsage(value: unknown, strict = false): ResourceUsage {
  const item = record(value, "usage");
  if (strict) {
    exactKeys(
      item,
      [
        "input_audio_ms",
        "llm_input_tokens",
        "llm_output_tokens",
        "asr_credits_charged",
        "llm_credits_charged",
        "credits_charged",
      ],
      "usage",
    );
  }
  const result = {
    input_audio_ms: nonNegativeInteger(item.input_audio_ms, "usage.input_audio_ms"),
    llm_input_tokens: nonNegativeInteger(
      item.llm_input_tokens,
      "usage.llm_input_tokens",
    ),
    llm_output_tokens: nonNegativeInteger(
      item.llm_output_tokens,
      "usage.llm_output_tokens",
    ),
    asr_credits_charged: nonNegativeInteger(
      item.asr_credits_charged,
      "usage.asr_credits_charged",
    ),
    llm_credits_charged: nonNegativeInteger(
      item.llm_credits_charged,
      "usage.llm_credits_charged",
    ),
    credits_charged: nonNegativeInteger(item.credits_charged, "usage.credits_charged"),
  };
  if (
    result.credits_charged !==
    result.asr_credits_charged + result.llm_credits_charged
  )
    invalid("usage.credits_charged");
  return result;
}

function namedOptions(value: unknown, label: string): NamedOption[] {
  if (!Array.isArray(value) || value.length === 0) invalid(label);
  const result = value.map((entry, index) => {
    const item = record(entry, `${label}[${index}]`);
    exactKeys(item, ["id", "name"], `${label}[${index}]`);
    return {
      id: nonEmpty(item.id, `${label}.id`),
      name: nonEmpty(item.name, `${label}.name`),
    };
  });
  assertUnique(
    result.map(({ id }) => id),
    label,
  );
  return result;
}

function mode(value: unknown): VoiceModeV2 {
  if (value !== "asr_only" && value !== "asr_llm") invalid("mode");
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    invalid(`${label} fields`);
}

function uniqueStrings(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    invalid(label);
  const result = value as string[];
  assertUnique(result, label);
  return result;
}

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function string(value: unknown, label: string) {
  if (typeof value !== "string") invalid(label);
  return value;
}

function nonEmpty(value: unknown, label: string) {
  const result = string(value, label);
  if (!result) invalid(label);
  return result;
}

function nonNegativeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(label);
  return value;
}

function positiveInteger(value: unknown, label: string) {
  const result = nonNegativeInteger(value, label);
  if (result === 0) invalid(label);
  return result;
}

function uuid(value: unknown, label: string) {
  const result = nonEmpty(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))
    invalid(label);
  return result;
}

function invalid(label: string): never {
  throw new InvalidApiResponseError(`服务响应字段无效：${label}`);
}
