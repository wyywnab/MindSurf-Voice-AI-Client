import assert from "node:assert/strict";
import test from "node:test";

import {
  MOCK_FAULTS,
  parseFaultConfiguration,
  printFaultHelp,
} from "./faults.mjs";

test("exposes every Phase 2 fault through stable startup names", () => {
  const config = parseFaultConfiguration(
    ["--fault", MOCK_FAULTS.join(","), "--fault-delay-ms", "2500"],
    {},
  );
  assert.deepEqual([...config.names], [...MOCK_FAULTS]);
  assert.equal(config.delayMs, 2500);
  for (const name of MOCK_FAULTS)
    assert.match(printFaultHelp(), new RegExp(name));
});

test("accepts environment configuration and rejects unknown faults", () => {
  const config = parseFaultConfiguration([], {
    MOCK_FAULTS: "asr_final_missing,request_done_missing",
    MOCK_FAULT_DELAY_MS: "500",
  });
  assert.deepEqual(
    [...config.names],
    ["asr_final_missing", "request_done_missing"],
  );
  assert.equal(config.delayMs, 500);
  assert.throws(
    () => parseFaultConfiguration(["--fault", "typo"], {}),
    /未知 Mock 故障场景/,
  );
});
