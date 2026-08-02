import type {
  TextOutputBackend,
  TextOutputTarget,
} from "../services/text-output/types";
import { requestStoreActions, useRequestStore } from "../stores/requestStore";
import { diagnosticsStoreActions } from "../stores/diagnosticsStore";
import { useSettingsStore } from "../stores/settingsStore";

export class TextOutputController {
  private delayResolve: (() => void) | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private target: TextOutputTarget | null = null;
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();

  constructor(private readonly backend: TextOutputBackend) {}

  async prepareTarget() {
    this.target = await this.backend.prepareTarget();
    return this.target;
  }

  async output(text: string, delayMs = 0, maxCodePoints?: number) {
    if (!text) return;
    const current = this.request.state.injectionStatus;
    if (current === "waiting" || current === "injecting") {
      requestStoreActions.setInjectionResult({
        status: current,
        error: "已有文本正在等待注入",
      });
      return;
    }
    if (
      this.request.state.injectionRemainingText &&
      this.request.state.injectionRemainingText !== text &&
      (current === "partial" || current === "failed")
    ) {
      requestStoreActions.setInjectionResult({
        status: current,
        error: "上次文本仍待处理，请先重试或放弃后再注入新文本",
      });
      return;
    }

    const sequence = ++this.sequence;
    const requestId = this.request.state.activeRequestId ?? undefined;
    diagnosticsStoreActions.recordTimeline(
      "text_output.started",
      "output",
      "开始输出文本",
      undefined,
      requestId,
    );
    requestStoreActions.setInjectionResult({
      status: delayMs > 0 ? "waiting" : "injecting",
      error: "",
      remainingText: text,
      report: null,
    });
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        this.delayResolve = resolve;
        this.delayTimer = setTimeout(() => {
          this.delayTimer = null;
          this.delayResolve = null;
          resolve();
        }, delayMs);
      });
      if (sequence !== this.sequence) return;
      requestStoreActions.setInjectionResult({ status: "injecting" });
    }

    const result = await this.backend.output(
      this.target,
      text,
      maxCodePoints ?? this.settings.state.injectionMaxCodePoints,
    );
    if (!result.ok) {
      requestStoreActions.setInjectionResult({
        status: "failed",
        error: describeInjectionError(result.code),
      });
      diagnosticsStoreActions.log("error", "text_output", result.code, "文本输出失败");
      return;
    }
    requestStoreActions.setInjectionResult({
      status: result.report.complete ? "succeeded" : "partial",
      error: result.report.complete
        ? ""
        : describeInjectionError(result.report.errorCode ?? "injection_partial"),
      remainingText: result.report.remainingText,
      report: result.report,
    });
    diagnosticsStoreActions.recordTimeline(
      "text_output.done",
      "output",
      result.report.complete ? "文本输出完成" : "文本仅完成部分输出",
      { injectedCodePoints: result.report.injectedCodePoints },
      requestId,
    );
  }

  async retry(delayMs = 1_500) {
    const remaining = this.request.state.injectionRemainingText;
    if (!remaining) return;
    requestStoreActions.setInjectionResult({ status: "idle" });
    await this.output(remaining, delayMs);
  }

  dismiss() {
    this.sequence += 1;
    this.clearDelay();
    this.target = null;
    requestStoreActions.setInjectionResult({
      status: "idle",
      error: "",
      remainingText: "",
      report: null,
    });
  }

  dispose() {
    this.dismiss();
  }

  private clearDelay() {
    if (this.delayTimer) clearTimeout(this.delayTimer);
    this.delayTimer = null;
    this.delayResolve?.();
    this.delayResolve = null;
  }
}

function describeInjectionError(code: string) {
  const messages: Record<string, string> = {
    empty_injection_text: "没有可以注入的文本",
    accessibility_required: "请先在系统设置中授予辅助功能权限",
    injection_blocked: "系统阻止了文本注入，目标应用可能不支持模拟输入",
    injection_modifiers_pressed: "录音快捷键尚未完全释放，请稍后重试",
    injection_partial: "仅注入了部分文本，剩余内容已保留",
    injection_target_closed: "目标窗口已关闭，剩余内容已保留",
    injection_target_changed: "注入期间前台窗口发生变化，剩余内容已保留",
    injection_target_is_self: "请切换到其他应用的输入位置后重试",
    injection_target_unavailable: "没有可用的前台目标窗口",
    injection_text_too_long: "文本超过当前注入长度限制",
    invalid_injection_limit: "注入长度限制无效",
    text_injection_unavailable: "系统文本注入功能当前不可用",
    unsupported_platform: "当前平台不支持文本注入",
  };
  return messages[code] ?? "文本注入失败，内容已保留";
}
