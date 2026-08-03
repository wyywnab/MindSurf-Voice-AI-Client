use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keyring::Entry;
use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;
use zeroize::Zeroize;

use crate::error::{AppError, CommandResult};

const CREDENTIAL_STORE: &str = "credentials.json";
const TOKEN_FIELD_PREFIX: &str = "service_token_ciphertext:";
const KEYRING_SERVICE: &str = "org.sast.mindsurf";
const KEYRING_USER: &str = "service-token-encryption-key";
const NONCE_LENGTH: usize = 12;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    configured: bool,
}

#[tauri::command]
pub fn get_credential_status(
    window: WebviewWindow,
    profile_id: String,
) -> CommandResult<CredentialStatus> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match credential_is_configured(window.app_handle(), &profile_id) {
        Ok(configured) => CommandResult::success(CredentialStatus { configured }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn save_service_token(
    window: WebviewWindow,
    profile_id: String,
    mut token: String,
) -> CommandResult<CredentialStatus> {
    if let Err(error) = super::access::require_main_window(&window) {
        token.zeroize();
        return CommandResult::failure(error);
    }
    let result = save_token(window.app_handle(), &profile_id, token.trim());
    token.zeroize();
    match result {
        Ok(()) => CommandResult::success(CredentialStatus { configured: true }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn clear_service_token(
    window: WebviewWindow,
    profile_id: String,
) -> CommandResult<CredentialStatus> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match clear_token(window.app_handle(), &profile_id) {
        Ok(()) => CommandResult::success(CredentialStatus { configured: false }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_service_token(
    window: WebviewWindow,
    profile_id: String,
) -> CommandResult<Option<String>> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match load_token(window.app_handle(), &profile_id) {
        Ok(token) => CommandResult::success(token),
        Err(error) => CommandResult::failure(error),
    }
}

fn save_token(app: &AppHandle, profile_id: &str, token: &str) -> Result<(), AppError> {
    let field = token_field(profile_id)?;
    if token.is_empty() || token.len() > 16_384 {
        return Err(credential_error(
            "invalid_service_token",
            "service token must contain between 1 and 16384 bytes",
        ));
    }
    let mut key = load_or_create_key()?;
    let encrypted = encrypt_token(token.as_bytes(), &key);
    key.zeroize();
    let ciphertext = encrypted?;
    let store = app.store(CREDENTIAL_STORE).map_err(store_error)?;
    store.set(field, ciphertext);
    store.save().map_err(store_error)
}

fn load_token(app: &AppHandle, profile_id: &str) -> Result<Option<String>, AppError> {
    let field = token_field(profile_id)?;
    let store = app.store(CREDENTIAL_STORE).map_err(store_error)?;
    let Some(ciphertext) = store
        .get(field)
        .and_then(|value| value.as_str().map(str::to_owned))
    else {
        return Ok(None);
    };
    let mut key = load_key()?.ok_or_else(|| {
        credential_error(
            "credential_key_missing",
            "credential encryption key is unavailable",
        )
    })?;
    let decrypted = decrypt_token(&ciphertext, &key);
    key.zeroize();
    let plaintext = decrypted?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| credential_error("credential_decryption_failed", "service token is invalid"))
}

fn clear_token(app: &AppHandle, profile_id: &str) -> Result<(), AppError> {
    let field = token_field(profile_id)?;
    let store = app.store(CREDENTIAL_STORE).map_err(store_error)?;
    store.delete(field);
    store.save().map_err(store_error)
}

pub(crate) fn clear_all_credentials(app: &AppHandle) -> Result<(), AppError> {
    let store = app.store(CREDENTIAL_STORE).map_err(store_error)?;
    store.clear();
    store.save().map_err(store_error)?;
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error(error)),
    }
}

fn credential_is_configured(app: &AppHandle, profile_id: &str) -> Result<bool, AppError> {
    let field = token_field(profile_id)?;
    let store = app.store(CREDENTIAL_STORE).map_err(store_error)?;
    Ok(store.has(field))
}

fn token_field(profile_id: &str) -> Result<String, AppError> {
    if profile_id.is_empty()
        || profile_id.len() > 128
        || !profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(credential_error(
            "invalid_service_profile",
            "service profile id is invalid",
        ));
    }
    Ok(format!("{TOKEN_FIELD_PREFIX}{profile_id}"))
}

fn load_or_create_key() -> Result<[u8; 32], AppError> {
    if let Some(key) = load_key()? {
        return Ok(key);
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    keyring_entry()?
        .set_password(&STANDARD.encode(key))
        .map_err(keyring_error)?;
    Ok(key)
}

fn load_key() -> Result<Option<[u8; 32]>, AppError> {
    let encoded = match keyring_entry()?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(keyring_error(error)),
    };
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        credential_error("credential_key_invalid", "credential key cannot be decoded")
    })?;
    bytes.try_into().map(Some).map_err(|_| {
        credential_error(
            "credential_key_invalid",
            "credential key has an invalid length",
        )
    })
}

fn keyring_entry() -> Result<Entry, AppError> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(keyring_error)
}

fn encrypt_token(token: &[u8], key: &[u8; 32]) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| encryption_error())?;
    let mut nonce = [0u8; NONCE_LENGTH];
    rand::thread_rng().fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), token)
        .map_err(|_| encryption_error())?;
    let mut payload = Vec::with_capacity(NONCE_LENGTH + encrypted.len());
    payload.extend_from_slice(&nonce);
    payload.extend_from_slice(&encrypted);
    Ok(STANDARD.encode(payload))
}

fn decrypt_token(payload: &str, key: &[u8; 32]) -> Result<Vec<u8>, AppError> {
    let payload = STANDARD.decode(payload).map_err(|_| encryption_error())?;
    if payload.len() <= NONCE_LENGTH {
        return Err(encryption_error());
    }
    let (nonce, ciphertext) = payload.split_at(NONCE_LENGTH);
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| encryption_error())?
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| encryption_error())
}

fn credential_error(code: &str, message: &str) -> AppError {
    AppError::new(code, message, true)
}

fn encryption_error() -> AppError {
    credential_error(
        "credential_encryption_failed",
        "service token encryption failed",
    )
}

fn keyring_error(error: keyring::Error) -> AppError {
    credential_error(
        "credential_key_unavailable",
        &format!("system credential store is unavailable: {error}"),
    )
}

fn store_error(error: impl std::fmt::Display) -> AppError {
    credential_error(
        "credential_store_unavailable",
        &format!("credential store is unavailable: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::{decrypt_token, encrypt_token, token_field};

    #[test]
    fn token_ciphertext_round_trips_without_plaintext() {
        let key = [7u8; 32];
        let token = b"secret-service-token";
        let encrypted = encrypt_token(token, &key).expect("token should encrypt");

        assert!(!encrypted.contains("secret-service-token"));
        assert_eq!(
            decrypt_token(&encrypted, &key).expect("token should decrypt"),
            token
        );
    }

    #[test]
    fn token_ciphertext_rejects_the_wrong_key() {
        let encrypted = encrypt_token(b"secret", &[1u8; 32]).expect("token should encrypt");
        assert!(decrypt_token(&encrypted, &[2u8; 32]).is_err());
    }

    #[test]
    fn isolates_tokens_by_valid_service_profile_id() {
        assert_ne!(
            token_field("local-mock").expect("profile should be valid"),
            token_field("production").expect("profile should be valid")
        );
        assert!(token_field("invalid/profile").is_err());
    }
}
