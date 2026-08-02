import { invoke, isTauri } from "@tauri-apps/api/core";

import type { CommandResult } from "../../types/app";

interface CredentialStatus {
  configured: boolean;
}

export async function getCredentialStatus() {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>("get_credential_status");
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function saveServiceToken(token: string) {
  const result = await invoke<CommandResult<CredentialStatus>>("save_service_token", {
    token,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function clearServiceToken() {
  const result = await invoke<CommandResult<CredentialStatus>>("clear_service_token");
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function readServiceTokenForConnection() {
  if (!isTauri()) return null;
  const result = await invoke<CommandResult<string | null>>("get_service_token");
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
