import { DirectInjectionBackend } from "./directInjectionBackend";
import type { TextOutputBackend } from "./types";

export function createTextOutputBackend(
  kind: TextOutputBackend["kind"] = "direct_injection",
): TextOutputBackend {
  if (kind === "direct_injection") return new DirectInjectionBackend();
  throw new Error(`文本输出 Backend 尚不可用：${kind}`);
}
