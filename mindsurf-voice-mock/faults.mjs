export const MOCK_FAULTS = Object.freeze([
  "authorize_rejected",
  "token_response_uncertain",
  "refresh_response_uncertain",
  "refresh_token_reused",
  "capabilities_stale",
  "ticket_expired",
  "ticket_consumed",
  "hello_timeout",
  "heartbeat_timeout",
  "accepted_timeout",
  "input_statistics_mismatch",
  "asr_failed",
  "llm_failed",
  "final_done_mismatch",
  "cancel_race",
  "request_done_missing",
  "disconnect_processing",
]);

const KNOWN_FAULTS = new Set(MOCK_FAULTS);

export function parseFaultConfiguration(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const rawFaults = optionValue(argv, "--fault") ?? env.MOCK_FAULTS ?? "";
  const names = rawFaults
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !KNOWN_FAULTS.has(name));
  if (unknown.length) {
    throw new Error(`未知 Mock 故障场景：${unknown.join(", ")}`);
  }
  const delayText =
    optionValue(argv, "--fault-delay-ms") ?? env.MOCK_FAULT_DELAY_MS ?? "250";
  const delayMs = Number.parseInt(delayText, 10);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 120_000) {
    throw new Error("Mock 故障延迟必须是 0 到 120000 毫秒之间的整数");
  }
  return Object.freeze({ names: new Set(names), delayMs });
}

export function printFaultHelp() {
  return [
    "用法：node server.mjs [--fault name[,name...]] [--fault-delay-ms 250]",
    "可用 Voice API v2 故障场景：",
    ...MOCK_FAULTS.map((name) => `  - ${name}`),
  ].join("\n");
}

function optionValue(argv, name) {
  const equals = argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
