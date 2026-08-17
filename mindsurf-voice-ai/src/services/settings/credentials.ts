import { invoke, isTauri } from "@tauri-apps/api/core";

import type { CommandResult } from "../../types/app";

interface CredentialStatus {
  configured: boolean;
}

export async function getRefreshTokenStatus() {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>(
    "get_refresh_token_status",
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function readRefreshToken() {
  if (!isTauri()) return null;
  const result = await invoke<CommandResult<string | null>>("get_refresh_token");
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function saveRefreshToken(token: string) {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>("save_refresh_token", {
    token,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function clearRefreshToken() {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>("clear_refresh_token");
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}
