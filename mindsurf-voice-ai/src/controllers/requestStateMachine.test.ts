import { describe, expect, it } from "vitest";

import {
  canTransitionRequest,
  createRequestTransition,
  InvalidRequestTransitionError,
  isTerminalRequestState,
} from "./requestStateMachine";

describe("requestStateMachine", () => {
  it("accepts the normal assistant request path", () => {
    const path = [
      "idle",
      "preparing",
      "recording",
      "committing",
      "recognizing",
      "generating",
      "playing",
      "completed",
    ] as const;

    for (let index = 1; index < path.length; index += 1) {
      expect(canTransitionRequest(path[index - 1], path[index])).toBe(true);
    }
  });

  it("rejects events that try to leave a terminal state", () => {
    expect(() =>
      createRequestTransition("completed", "playing", "late audio", () => 42),
    ).toThrow(InvalidRequestTransitionError);
  });

  it("allows a new request after every terminal state", () => {
    for (const state of ["completed", "cancelled", "failed"] as const) {
      expect(isTerminalRequestState(state)).toBe(true);
      expect(canTransitionRequest(state, "preparing")).toBe(true);
    }
  });

  it("allows cancellation and failure from every active state", () => {
    for (const state of [
      "preparing",
      "recording",
      "committing",
      "recognizing",
      "generating",
      "playing",
    ] as const) {
      expect(canTransitionRequest(state, "cancelling")).toBe(true);
      expect(canTransitionRequest(state, "failed")).toBe(true);
    }
    expect(canTransitionRequest("cancelling", "cancelled")).toBe(true);
    expect(canTransitionRequest("cancelling", "completed")).toBe(false);
  });

  it("records deterministic transition metadata", () => {
    expect(createRequestTransition("idle", "preparing", "test", () => 123)).toEqual({
      from: "idle",
      to: "preparing",
      reason: "test",
      atMonotonicMs: 123,
    });
  });
});
