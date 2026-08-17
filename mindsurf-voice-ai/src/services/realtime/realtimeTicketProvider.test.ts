import { describe, expect, it } from "vitest";
import type { RealtimeTicket } from "../../types/httpApi";
import { buildRealtimeConnectionTicket } from "./realtimeTicketProvider";

function ticket(overrides: Partial<RealtimeTicket> = {}): RealtimeTicket {
  return {
    ticket: "opaque-ticket-with-special-value-+/=1234567890",
    expires_at_ms: 40_000,
    websocket_path: "/issued/socket?region=cn",
    subprotocol: "mindsurf.voice.v2",
    ...overrides,
  };
}

describe("buildRealtimeConnectionTicket", () => {
  it("maps HTTPS to WSS and percent-encodes the ticket", () => {
    const result = buildRealtimeConnectionTicket(
      "https://api.example.com",
      ticket(),
      1_000,
    );
    const url = new URL(result.url);
    expect(url.protocol).toBe("wss:");
    expect(url.origin).toBe("wss://api.example.com");
    expect(url.pathname).toBe("/issued/socket");
    expect(url.searchParams.get("region")).toBe("cn");
    expect(url.searchParams.get("ticket")).toBe(
      "opaque-ticket-with-special-value-+/=1234567890",
    );
    expect(result.url).not.toContain("+/=");
  });

  it("maps explicit loopback HTTP to WS", () => {
    expect(
      buildRealtimeConnectionTicket("http://127.0.0.1:8000", ticket(), 1_000).url,
    ).toMatch(/^ws:\/\/127\.0\.0\.1:8000\//);
  });

  it("rejects authority changes, existing ticket parameters, fragments and expiry", () => {
    expect(() =>
      buildRealtimeConnectionTicket(
        "https://api.example.com",
        ticket({ websocket_path: "//evil.example/socket" }),
        1_000,
      ),
    ).toThrow(/authority/);
    expect(() =>
      buildRealtimeConnectionTicket(
        "https://api.example.com",
        ticket({ websocket_path: "/socket?ticket=forged" }),
        1_000,
      ),
    ).toThrow();
    expect(() =>
      buildRealtimeConnectionTicket(
        "https://api.example.com",
        ticket({ websocket_path: "/socket#fragment" }),
        1_000,
      ),
    ).toThrow();
    expect(() =>
      buildRealtimeConnectionTicket(
        "https://api.example.com",
        ticket({ expires_at_ms: 2_000 }),
        1_000,
      ),
    ).toThrow(/过期/);
  });
});
