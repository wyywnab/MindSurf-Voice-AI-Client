import {
  injectTextIntoForegroundWindow,
  prepareTextInjectionTarget,
} from "../textInjection";
import type { TextOutputBackend, TextOutputResult, TextOutputTarget } from "./types";

export class DirectInjectionBackend implements TextOutputBackend {
  readonly kind = "direct_injection" as const;

  async isAvailable() {
    return true;
  }

  async prepareTarget(): Promise<TextOutputTarget> {
    await prepareTextInjectionTarget();
    return { prepared: true };
  }

  async output(
    _target: TextOutputTarget | null,
    text: string,
    maxCodePoints: number,
  ): Promise<TextOutputResult> {
    const result = await injectTextIntoForegroundWindow(text, maxCodePoints);
    return result.ok
      ? { ok: true, report: result.data }
      : {
          ok: false,
          code: result.error.code,
          message: result.error.message,
        };
  }
}
