import type {
  RequestLifecycleState,
  RequestTerminalState,
  RequestTransition,
} from "../types/request";

const TERMINAL_STATES = new Set<RequestLifecycleState>([
  "completed",
  "cancelled",
  "failed",
]);

const NORMAL_TRANSITIONS: Record<
  RequestLifecycleState,
  ReadonlySet<RequestLifecycleState>
> = {
  idle: new Set(["preparing"]),
  preparing: new Set(["recording", "cancelling", "failed"]),
  recording: new Set(["committing", "cancelling", "failed"]),
  committing: new Set(["recognizing", "cancelling", "failed"]),
  recognizing: new Set(["generating", "completed", "cancelling", "failed"]),
  generating: new Set(["playing", "completed", "cancelling", "failed"]),
  playing: new Set(["completed", "cancelling", "failed"]),
  completed: new Set(["preparing"]),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(["preparing"]),
  failed: new Set(["preparing"]),
};

export class InvalidRequestTransitionError extends Error {
  constructor(
    readonly from: RequestLifecycleState,
    readonly to: RequestLifecycleState,
  ) {
    super(`非法请求状态转换：${from} -> ${to}`);
    this.name = "InvalidRequestTransitionError";
  }
}

export function isTerminalRequestState(
  state: RequestLifecycleState,
): state is RequestTerminalState {
  return TERMINAL_STATES.has(state);
}

export function canTransitionRequest(
  from: RequestLifecycleState,
  to: RequestLifecycleState,
) {
  return from === to || NORMAL_TRANSITIONS[from].has(to);
}

export function createRequestTransition(
  from: RequestLifecycleState,
  to: RequestLifecycleState,
  reason: string,
  now: () => number = () => performance.now(),
): RequestTransition {
  if (!canTransitionRequest(from, to)) {
    throw new InvalidRequestTransitionError(from, to);
  }
  return { from, to, reason, atMonotonicMs: now() };
}
