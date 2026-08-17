const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface PkceAttempt {
  state: string;
  verifier: string;
  challenge: string;
  createdAt: number;
}

export async function createPkceAttempt(now = Date.now()): Promise<PkceAttempt> {
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(32);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    state,
    verifier,
    challenge: encodeBase64Url(new Uint8Array(digest)),
    createdAt: now,
  };
}

export function constantTimeEqual(left: string, right: string) {
  const max = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function isValidVerifier(value: string) {
  return value.length >= 43 && value.length <= 128 && BASE64URL.test(value);
}

function randomBase64Url(bytes: number) {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return encodeBase64Url(value);
}

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
