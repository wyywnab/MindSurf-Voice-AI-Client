export class InvalidApiOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiOriginError";
  }
}

export function validateApiOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidApiOriginError("API 地址格式无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidApiOriginError("API 地址必须使用 https:// 或 http://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InvalidApiOriginError("API 地址不能包含凭据、查询参数或 fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new InvalidApiOriginError("API 地址只能包含 origin，不能包含路径");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new InvalidApiOriginError("非本机 API 必须使用 https://");
  }
  return url.origin;
}

function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
