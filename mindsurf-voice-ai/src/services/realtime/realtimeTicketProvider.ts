import type { RealtimeTicket } from "../../types/httpApi";
import { ReauthenticationRequiredError, TokenManager } from "../auth/tokenManager";
import { VoiceApiClient } from "../http/voiceApiClient";

const MIN_TICKET_LIFETIME_MS = 1_000;

export interface RealtimeConnectionTicket {
  url: string;
  subprotocol: "mindsurf.voice.v2";
  expiresAtMs: number;
}

export class RealtimeTicketError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeTicketError";
  }
}

export class RealtimeTicketProvider {
  constructor(
    private readonly api: VoiceApiClient,
    private readonly tokens: TokenManager,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(): Promise<RealtimeConnectionTicket> {
    if (!this.tokens.hasUsableAccessToken(this.now())) {
      let restored;
      try {
        restored = await this.tokens.refresh();
      } catch (error) {
        if (error instanceof ReauthenticationRequiredError) {
          throw new RealtimeTicketError("authentication_required", error.message);
        }
        throw error;
      }
      if (!restored) {
        throw new RealtimeTicketError(
          "authentication_required",
          "需要登录后才能连接语音服务",
        );
      }
    }
    const ticket = await this.api.createRealtimeTicket();
    return buildRealtimeConnectionTicket(this.api.origin, ticket, this.now());
  }
}

export function buildRealtimeConnectionTicket(
  apiOrigin: string,
  ticket: RealtimeTicket,
  now = Date.now(),
): RealtimeConnectionTicket {
  if (ticket.expires_at_ms <= now + MIN_TICKET_LIFETIME_MS) {
    throw new RealtimeTicketError("realtime_ticket_expired", "实时连接凭据已过期");
  }
  const httpOrigin = new URL(apiOrigin);
  const websocketUrl = new URL(ticket.websocket_path, httpOrigin);
  if (websocketUrl.origin !== httpOrigin.origin) {
    throw new RealtimeTicketError(
      "realtime_ticket_authority_mismatch",
      "实时连接路径试图改变 API authority",
    );
  }
  if (websocketUrl.hash || websocketUrl.searchParams.has("ticket")) {
    throw new RealtimeTicketError(
      "realtime_ticket_path_invalid",
      "实时连接路径不能预先包含 ticket 参数",
    );
  }
  websocketUrl.protocol = httpOrigin.protocol === "https:" ? "wss:" : "ws:";
  websocketUrl.searchParams.set("ticket", ticket.ticket);
  return {
    url: websocketUrl.toString(),
    subprotocol: ticket.subprotocol,
    expiresAtMs: ticket.expires_at_ms,
  };
}
