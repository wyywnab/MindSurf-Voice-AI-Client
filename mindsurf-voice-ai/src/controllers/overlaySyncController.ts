import {
  hideOverlayWindow,
  publishOverlaySnapshot,
  showOverlayWindow,
  subscribeOverlayActions,
} from "../services/overlay";
import type { OverlaySnapshot } from "../types/overlay";

const METER_INTERVAL_MS = 67;

export class OverlaySyncController {
  private disposed = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private pending: OverlaySnapshot | null = null;
  private shown = false;
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly options: {
      createSnapshot(): OverlaySnapshot;
      isEnabled(): boolean;
      isTerminal(): boolean;
      onCancel(): void;
    },
  ) {}

  start() {
    this.meterTimer = setInterval(() => {
      if (this.shown) this.publish();
    }, METER_INTERVAL_MS);
    void subscribeOverlayActions({
      onCancel: this.options.onCancel,
      onReady: () => this.publish(),
    })
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      })
      .catch(() => {
        // Preview: 普通浏览器预览不提供悬浮窗事件。
      });
  }

  publish() {
    if (this.disposed) return;
    this.pending = this.options.createSnapshot();
    void this.flush();
  }

  async showBeforeShortcut() {
    if (!this.options.isEnabled()) return;
    this.shown = true;
    this.publish();
    await showOverlayWindow();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  }

  syncVisibility(active: boolean) {
    this.clearHideTimer();
    if (!this.options.isEnabled()) {
      this.hide();
      return;
    }
    if (this.options.isTerminal()) {
      this.shown = true;
      this.publish();
      this.hideTimer = setTimeout(() => this.hide(), 2_000);
      return;
    }
    if (active) {
      this.shown = true;
      this.publish();
      void showOverlayWindow();
      return;
    }
    this.hide();
  }

  dispose() {
    this.disposed = true;
    this.pending = null;
    this.clearHideTimer();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.shown = false;
    void hideOverlayWindow();
    this.unlisten?.();
    this.unlisten = null;
  }

  private async flush() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.pending && !this.disposed) {
        const snapshot = this.pending;
        this.pending = null;
        await publishOverlaySnapshot(snapshot);
      }
    } finally {
      this.inFlight = false;
      if (this.pending && !this.disposed) void this.flush();
    }
  }

  private hide() {
    this.clearHideTimer();
    this.shown = false;
    void hideOverlayWindow();
  }

  private clearHideTimer() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
