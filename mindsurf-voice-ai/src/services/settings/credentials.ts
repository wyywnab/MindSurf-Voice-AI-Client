import { invoke, isTauri } from "@tauri-apps/api/core";

import type { CommandResult } from "../../types/app";

interface CredentialStatus {
  configured: boolean;
}

export async function getCredentialStatus(profileId: string) {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>(
    "get_credential_status",
    { profileId },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function saveServiceToken(profileId: string, token: string) {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>("save_service_token", {
    profileId,
    token,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function clearServiceToken(profileId: string) {
  if (!isTauri()) return false;
  const result = await invoke<CommandResult<CredentialStatus>>("clear_service_token", {
    profileId,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.configured;
}

export async function readServiceTokenForConnection(profileId: string) {
  if (!isTauri()) return null;
  const result = await invoke<CommandResult<string | null>>("get_service_token", {
    profileId,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
