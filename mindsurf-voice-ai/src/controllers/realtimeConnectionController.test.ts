import { beforeEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../services/realtime/voiceTransportV2", () => ({
  VoiceTransportV2: class {
    connect = vi.fn(() => Promise.resolve());
    disconnect = vi.fn();
    negotiatedServerHello = null;

    constructor() {
      transportMocks.instances.push(this);
    }
  },
}));

import { RealtimeConnectionController } from "./realtimeConnectionController";

describe("RealtimeConnectionController", () => {
  beforeEach(() => {
    transportMocks.instances.length = 0;
  });

  it("keeps the configured transport reusable after disconnect", async () => {
    const controller = new RealtimeConnectionController();
    controller.configure(
      {} as never,
      { version: "1.0.0", platform: "macos", arch: "aarch64" },
      vi.fn(),
      vi.fn(),
    );
    const transport = transportMocks.instances[0];

    controller.disconnect();
    await controller.connect();

    expect(transport.disconnect).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledTimes(1);
  });
});
