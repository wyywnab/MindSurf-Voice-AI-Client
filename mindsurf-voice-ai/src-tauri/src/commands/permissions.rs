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
    #[cfg(target_os = "macos")]
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

    #[cfg(target_os = "macos")]
    fn with_status(permission: SystemPermission, status: &'static str) -> Self {
        Self { permission, status }
    }
}

#[tauri::command]
pub fn get_system_permission_status(
    permission: SystemPermission,
) -> CommandResult<SystemPermissionStatus> {
    platform::status(permission)
}

#[tauri::command]
pub async fn request_system_permission(
    permission: SystemPermission,
) -> CommandResult<SystemPermissionStatus> {
    platform::request(permission).await
}

#[cfg(target_os = "macos")]
pub(crate) fn accessibility_is_trusted() -> bool {
    platform::accessibility_is_trusted()
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

    pub async fn request(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
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
    use block2::RcBlock;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFString;
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio,
    };

    use super::{AppError, CommandResult, SystemPermission, SystemPermissionStatus};

    pub fn status(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        let status = match permission {
            SystemPermission::Microphone => microphone_status(permission),
            SystemPermission::Accessibility => {
                SystemPermissionStatus::new(permission, accessibility_is_trusted())
            }
            // macOS does not expose a reliable API for whether the application is
            // explicitly enabled in the Input Monitoring settings pane. In
            // particular, CGPreflightListenEventAccess may also return true when
            // Accessibility grants equivalent event-listening capability.
            SystemPermission::InputMonitoring => SystemPermissionStatus::unknown(permission),
        };
        CommandResult::success(status)
    }

    pub async fn request(permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        let status = match permission {
            SystemPermission::Microphone => return request_microphone(permission).await,
            SystemPermission::Accessibility => {
                SystemPermissionStatus::new(permission, request_accessibility())
            }
            SystemPermission::InputMonitoring => SystemPermissionStatus::unknown(permission),
        };
        CommandResult::success(status)
    }

    pub fn accessibility_is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    fn request_accessibility() -> bool {
        let options = CFDictionary::from_CFType_pairs(&[(
            CFString::new("AXTrustedCheckOptionPrompt"),
            CFBoolean::true_value(),
        )]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
    }

    fn microphone_status(permission: SystemPermission) -> SystemPermissionStatus {
        let Ok(media_type) = microphone_media_type() else {
            return SystemPermissionStatus::unknown(permission);
        };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        SystemPermissionStatus::with_status(permission, microphone_status_name(status))
    }

    async fn request_microphone(
        permission: SystemPermission,
    ) -> CommandResult<SystemPermissionStatus> {
        let media_type = match microphone_media_type() {
            Ok(media_type) => media_type,
            Err(error) => return CommandResult::failure(error),
        };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        if status != AVAuthorizationStatus::NotDetermined {
            return CommandResult::success(SystemPermissionStatus::with_status(
                permission,
                microphone_status_name(status),
            ));
        }

        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        {
            let handler = RcBlock::new(move |granted| {
                let _ = sender.blocking_send(bool::from(granted));
            });
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
            }
        }

        match receiver.recv().await {
            Some(_) => CommandResult::success(microphone_status(permission)),
            None => CommandResult::failure(AppError::new(
                "microphone_permission_request_failed",
                "macOS did not return a microphone permission decision",
                true,
            )),
        }
    }

    fn microphone_media_type() -> Result<&'static AVMediaType, AppError> {
        unsafe { AVMediaTypeAudio }.ok_or_else(|| {
            AppError::new(
                "microphone_permission_unavailable",
                "AVFoundation audio permission support is unavailable",
                false,
            )
        })
    }

    fn microphone_status_name(status: AVAuthorizationStatus) -> &'static str {
        match status {
            AVAuthorizationStatus::NotDetermined => "not_determined",
            AVAuthorizationStatus::Restricted => "restricted",
            AVAuthorizationStatus::Denied => "denied",
            AVAuthorizationStatus::Authorized => "granted",
            _ => "unknown",
        }
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

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{AppError, CommandResult, SystemPermission, SystemPermissionStatus};

    pub fn status(_permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
        unsupported()
    }

    pub async fn request(_permission: SystemPermission) -> CommandResult<SystemPermissionStatus> {
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
