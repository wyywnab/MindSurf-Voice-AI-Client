use serde::{Deserialize, Serialize};

use crate::error::{AppError, CommandResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemPermission {
    Microphone,
    Accessibility,
    InputMonitoring,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPermissionStatus {
    permission: SystemPermission,
    status: &'static str,
}

impl SystemPermissionStatus {
    fn new(permission: SystemPermission, granted: bool) -> Self {
        Self {
            permission,
            status: if granted { "granted" } else { "denied" },
        }
    }

    fn unknown(permission: SystemPermission) -> Self {
        Self {
            permission,
            status: "unknown",
        }
    }
}

#[tauri::command]
pub fn get_system_permission_status(
    permission: SystemPermission,
) -> CommandResult<SystemPermissionStatus> {
    platform::status(permission)
}

#[tauri::command]
pub fn request_system_permission(
    permission: SystemPermission,
) -> CommandResult<SystemPermissionStatus> {
    platform::request(permission)
}

#[tauri::command]
pub fn open_permission_settings(permission: Option<SystemPermission>) -> CommandResult<()> {
    platform::open_settings(permission.unwrap_or(SystemPermission::Microphone))
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{AppError, CommandResult, SystemPermission, SystemPermissionStatus};

    pub fn status(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        match permission {
            SystemPermission::Microphone => {
                CommandResult::success(SystemPermissionStatus::unknown(permission))
            }
            _ => unsupported(),
        }
    }

    pub fn request(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        match permission {
            SystemPermission::Microphone => {
                CommandResult::success(SystemPermissionStatus::unknown(permission))
            }
            _ => unsupported(),
        }
    }

    pub fn open_settings(permission: SystemPermission) -> CommandResult<()> {
        if permission != SystemPermission::Microphone {
            return CommandResult::failure(AppError::new(
                "unsupported_permission",
                "this permission is not used on Windows",
                false,
            ));
        }

        match std::process::Command::new("explorer.exe")
            .arg("ms-settings:privacy-microphone")
            .spawn()
        {
            Ok(_) => CommandResult::success(()),
            Err(_) => CommandResult::failure(AppError::new(
                "permission_settings_unavailable",
                "unable to open Windows microphone settings",
                true,
            )),
        }
    }

    fn unsupported<T>() -> CommandResult<T> {
        CommandResult::failure(AppError::new(
            "unsupported_permission",
            "this permission is not used on Windows",
            false,
        ))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_core_graphics::{
        CGPreflightListenEventAccess, CGPreflightPostEventAccess, CGRequestListenEventAccess,
        CGRequestPostEventAccess,
    };

    use super::{AppError, CommandResult, SystemPermission, SystemPermissionStatus};

    pub fn status(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        let status = match permission {
            // WKWebView owns the actual microphone request. The frontend tracks
            // this state through getUserMedia and the Permissions API.
            SystemPermission::Microphone => SystemPermissionStatus::unknown(permission),
            SystemPermission::Accessibility => {
                SystemPermissionStatus::new(permission, CGPreflightPostEventAccess())
            }
            SystemPermission::InputMonitoring => {
                SystemPermissionStatus::new(permission, CGPreflightListenEventAccess())
            }
        };
        CommandResult::success(status)
    }

    pub fn request(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        let status = match permission {
            SystemPermission::Microphone => SystemPermissionStatus::unknown(permission),
            SystemPermission::Accessibility => {
                SystemPermissionStatus::new(permission, CGRequestPostEventAccess())
            }
            SystemPermission::InputMonitoring => {
                SystemPermissionStatus::new(permission, CGRequestListenEventAccess())
            }
        };
        CommandResult::success(status)
    }

    pub fn open_settings(permission: SystemPermission) -> CommandResult<()> {
        let pane = match permission {
            SystemPermission::Microphone => "Privacy_Microphone",
            SystemPermission::Accessibility => "Privacy_Accessibility",
            SystemPermission::InputMonitoring => "Privacy_ListenEvent",
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");

        match std::process::Command::new("/usr/bin/open").arg(url).spawn() {
            Ok(_) => CommandResult::success(()),
            Err(_) => CommandResult::failure(AppError::new(
                "permission_settings_unavailable",
                "unable to open macOS Privacy & Security settings",
                true,
            )),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{AppError, CommandResult, SystemPermission, SystemPermissionStatus};

    pub fn status(_permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        unsupported()
    }

    pub fn request(_permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        unsupported()
    }

    pub fn open_settings(_permission: SystemPermission) -> CommandResult<()> {
        unsupported()
    }

    fn unsupported<T>() -> CommandResult<T> {
        CommandResult::failure(AppError::new(
            "unsupported_platform",
            "system permission integration is only implemented for Windows and macOS",
            false,
        ))
    }
}
