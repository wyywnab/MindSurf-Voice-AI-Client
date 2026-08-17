use keyring::Entry;
use serde::Serialize;
use tauri::WebviewWindow;
use tauri_plugin_store::StoreExt;
use zeroize::Zeroize;

use crate::error::{AppError, CommandResult};

const KEYRING_SERVICE: &str = "org.sast.mindsurf";
const REFRESH_TOKEN_KEYRING_USER: &str = "voice-api-v2-refresh-token";
const OBSOLETE_CREDENTIAL_STORE: &str = "credentials.json";
const OBSOLETE_KEYRING_USER: &str = "service-token-encryption-key";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    configured: bool,
}

#[tauri::command]
pub fn get_refresh_token_status(window: WebviewWindow) -> CommandResult<CredentialStatus> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match load_refresh_token() {
        Ok(token) => CommandResult::success(CredentialStatus {
            configured: token.is_some(),
        }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_refresh_token(window: WebviewWindow) -> CommandResult<Option<String>> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match load_refresh_token() {
        Ok(token) => CommandResult::success(token),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn save_refresh_token(
    window: WebviewWindow,
    mut token: String,
) -> CommandResult<CredentialStatus> {
    if let Err(error) = super::access::require_main_window(&window) {
        token.zeroize();
        return CommandResult::failure(error);
    }
    let value = token.trim();
    let result = if value.is_empty() || value.len() > 16_384 {
        Err(credential_error(
            "invalid_refresh_token",
            "refresh token must contain between 1 and 16384 bytes",
        ))
    } else {
        refresh_token_entry().and_then(|entry| entry.set_password(value).map_err(keyring_error))
    };
    token.zeroize();
    match result {
        Ok(()) => CommandResult::success(CredentialStatus { configured: true }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn clear_refresh_token(window: WebviewWindow) -> CommandResult<CredentialStatus> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match delete_refresh_token() {
        Ok(()) => CommandResult::success(CredentialStatus { configured: false }),
        Err(error) => CommandResult::failure(error),
    }
}

pub(crate) fn clear_all_credentials(app: &tauri::AppHandle) -> Result<(), AppError> {
    purge_obsolete_credentials(app)?;
    delete_refresh_token()
}

pub(crate) fn purge_obsolete_credentials(app: &tauri::AppHandle) -> Result<(), AppError> {
    let store = app
        .store(OBSOLETE_CREDENTIAL_STORE)
        .map_err(credential_store_error)?;
    store.clear();
    store.save().map_err(credential_store_error)?;
    match Entry::new(KEYRING_SERVICE, OBSOLETE_KEYRING_USER)
        .map_err(keyring_error)?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error(error)),
    }
}

fn load_refresh_token() -> Result<Option<String>, AppError> {
    match refresh_token_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

fn delete_refresh_token() -> Result<(), AppError> {
    match refresh_token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error(error)),
    }
}

fn refresh_token_entry() -> Result<Entry, AppError> {
    Entry::new(KEYRING_SERVICE, REFRESH_TOKEN_KEYRING_USER).map_err(keyring_error)
}

fn credential_error(code: &str, message: &str) -> AppError {
    AppError::new(code, message, true)
}

fn keyring_error(error: keyring::Error) -> AppError {
    credential_error(
        "credential_key_unavailable",
        &format!("system credential store is unavailable: {error}"),
    )
}

fn credential_store_error(error: impl std::fmt::Display) -> AppError {
    credential_error(
        "credential_store_unavailable",
        &format!("obsolete credential cleanup failed: {error}"),
    )
}
