use tauri::WebviewWindow;

use crate::error::AppError;

pub(crate) fn require_main_window(window: &WebviewWindow) -> Result<(), AppError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(AppError::new(
            "window_capability_denied",
            "this command is only available to the main window",
            false,
        ))
    }
}
