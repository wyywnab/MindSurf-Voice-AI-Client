export class InvalidServiceUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidServiceUrlError";
  }
}

export function validateServiceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidServiceUrlError("服务地址格式无效");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new InvalidServiceUrlError("服务地址必须使用 ws:// 或 wss://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InvalidServiceUrlError("服务地址不能包含凭据、查询参数或 fragment");
  }
  if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
    throw new InvalidServiceUrlError("非本机服务必须使用 wss://");
  }
  return url.toString();
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
  );
}
