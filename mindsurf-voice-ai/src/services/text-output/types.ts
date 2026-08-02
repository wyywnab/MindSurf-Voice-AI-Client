import type { TextInjectionReport } from "../../types/injection";

export interface TextOutputTarget {
  prepared: boolean;
}

export type TextOutputResult =
  | { ok: true; report: TextInjectionReport }
  | { ok: false; code: string; message: string };

export interface TextOutputBackend {
  readonly kind: "direct_injection" | "input_method";
  isAvailable(): Promise<boolean>;
  prepareTarget(): Promise<TextOutputTarget | null>;
  output(
    target: TextOutputTarget | null,
    text: string,
    maxCodePoints: number,
  ): Promise<TextOutputResult>;
}
