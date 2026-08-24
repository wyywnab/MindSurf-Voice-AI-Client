import {
  VoiceApiError,
  VoiceApiExtensionUnsupportedError,
} from "../services/http/voiceApiClient";
import {
  polishPromptStoreActions,
  usePolishPromptStore,
} from "../stores/polishPromptStore";
import type { PolishPromptConstraints } from "../types/httpApi";
import { authController } from "./authController";

export class PolishPromptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolishPromptValidationError";
  }
}

export class PolishPromptController {
  private readonly store = usePolishPromptStore();
  private loadInFlight: Promise<void> | null = null;

  async load(force = false) {
    if (!force && this.store.state.status === "ready") return;
    if (this.loadInFlight) return this.loadInFlight;
    this.loadInFlight = this.performLoad().finally(() => {
      this.loadInFlight = null;
    });
    return this.loadInFlight;
  }

  async save(prompt: string): Promise<"saved" | "conflict"> {
    const resource = this.requireResource();
    validatePolishPrompt(prompt, resource.configuration.constraints);
    polishPromptStoreActions.setSaving();
    try {
      const updated = await authController.setPolishPrompt(prompt, resource.etag);
      polishPromptStoreActions.setResource(updated);
      return "saved";
    } catch (error) {
      return this.handleMutationError(error);
    }
  }

  async resetToDefault(): Promise<"saved" | "conflict"> {
    const resource = this.requireResource();
    polishPromptStoreActions.setSaving();
    try {
      const updated = await authController.resetPolishPrompt(resource.etag);
      polishPromptStoreActions.setResource(updated);
      return "saved";
    } catch (error) {
      return this.handleMutationError(error);
    }
  }

  acceptRemote() {
    polishPromptStoreActions.clearConflict();
  }

  reset() {
    polishPromptStoreActions.reset();
  }

  private async performLoad() {
    polishPromptStoreActions.setLoading();
    try {
      polishPromptStoreActions.setResource(await authController.getPolishPrompt());
    } catch (error) {
      this.applyError(error);
    }
  }

  private async handleMutationError(error: unknown): Promise<"conflict"> {
    if (
      error instanceof VoiceApiError &&
      error.status === 412 &&
      error.code === "polish_prompt_revision_conflict"
    ) {
      try {
        const remote = await authController.getPolishPrompt();
        polishPromptStoreActions.setResource(remote, true);
        return "conflict";
      } catch (refreshError) {
        this.applyError(refreshError);
        throw refreshError;
      }
    }
    this.applyError(error);
    throw error;
  }

  private applyError(error: unknown) {
    if (error instanceof VoiceApiExtensionUnsupportedError) {
      polishPromptStoreActions.setUnsupported();
      return;
    }
    polishPromptStoreActions.setError(describeError(error));
  }

  private requireResource() {
    const resource = this.store.state.resource;
    if (!resource) throw new Error("润色提示词尚未加载");
    return resource;
  }
}

export function validatePolishPrompt(
  prompt: string,
  constraints: PolishPromptConstraints,
) {
  if (!prompt.trim()) {
    throw new PolishPromptValidationError("提示词去除首尾空白后不能为空");
  }
  if (prompt.includes("\u0000")) {
    throw new PolishPromptValidationError("提示词不能包含空字符 U+0000");
  }
  const codePoints = [...prompt].length;
  if (codePoints > constraints.max_code_points) {
    throw new PolishPromptValidationError(
      `提示词不能超过 ${constraints.max_code_points} 个字符`,
    );
  }
  const utf8Bytes = new globalThis.TextEncoder().encode(prompt).byteLength;
  if (utf8Bytes > constraints.max_utf8_bytes) {
    throw new PolishPromptValidationError(
      `提示词 UTF-8 编码不能超过 ${constraints.max_utf8_bytes} 字节`,
    );
  }
  return { codePoints, utf8Bytes };
}

function describeError(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "润色提示词操作失败，请稍后重试";
}

export const polishPromptController = new PolishPromptController();
