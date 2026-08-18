use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::error::{AppError, CommandResult};

use super::{credentials, diagnostics};

const SETTINGS_STORE: &str = "settings.json";
const HISTORY_STORE: &str = "recognition-history.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedLocalData {
    settings: bool,
    credentials: bool,
    diagnostic_logs: bool,
    recognition_history: bool,
}

#[tauri::command]
pub fn clear_local_application_data(window: WebviewWindow) -> CommandResult<ClearedLocalData> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match clear_local_data(window.app_handle()) {
        Ok(data) => CommandResult::success(data),
        Err(error) => CommandResult::failure(error),
    }
}

fn clear_local_data(app: &AppHandle) -> Result<ClearedLocalData, AppError> {
    let settings = app.store(SETTINGS_STORE).map_err(local_data_error)?;
    settings.clear();
    settings.save().map_err(local_data_error)?;
    let history = app.store(HISTORY_STORE).map_err(local_data_error)?;
    history.clear();
    history.save().map_err(local_data_error)?;
    credentials::clear_all_credentials(app)?;
    diagnostics::clear_logs(app)?;
    Ok(ClearedLocalData {
        settings: true,
        credentials: true,
        diagnostic_logs: true,
        recognition_history: true,
    })
}

fn local_data_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(
        "local_data_clear_failed",
        format!("local application data could not be cleared: {error}"),
        true,
    )
}
