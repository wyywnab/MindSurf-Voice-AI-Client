use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

use crate::error::{AppError, CommandResult};

const DEFAULT_MAX_CODE_POINTS: usize = 8_000;
#[cfg(target_os = "windows")]
const INPUTS_PER_BATCH: usize = 256;
static INJECTION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetWindow {
    handle: isize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectReport {
    requested_code_points: usize,
    injected_code_points: usize,
    remaining_text: String,
    elapsed_ms: u128,
    complete: bool,
    error_code: Option<&'static str>,
}

pub trait TextInjector: Send + Sync {
    fn capture_target(&self) -> Result<TargetWindow, AppError>;
    fn inject(&self, target: &TargetWindow, text: &str) -> Result<InjectReport, AppError>;
}

#[tauri::command]
pub fn inject_text(text: String, max_code_points: Option<usize>) -> CommandResult<InjectReport> {
    let max_code_points = max_code_points.unwrap_or(DEFAULT_MAX_CODE_POINTS);
    if max_code_points == 0 || max_code_points > DEFAULT_MAX_CODE_POINTS {
        return CommandResult::failure(AppError::new(
            "invalid_injection_limit",
            "text injection limit must be between 1 and 8000 code points",
            true,
        ));
    }

    let requested_code_points = normalized_code_point_count(&text);
    if requested_code_points == 0 {
        return CommandResult::failure(AppError::new(
            "empty_injection_text",
            "there is no text to inject",
            true,
        ));
    }
    if requested_code_points > max_code_points {
        return CommandResult::failure(AppError::new(
            "injection_text_too_long",
            format!(
                "text has {requested_code_points} code points, exceeding the configured limit of {max_code_points}"
            ),
            true,
        ));
    }

    let _guard = match INJECTION_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return CommandResult::failure(AppError::new(
                "injection_unavailable",
                "text injection lock is unavailable",
                true,
            ));
        }
    };

    let injector = platform::PlatformTextInjector;
    if let Err(error) = platform::wait_for_modifiers_released() {
        return CommandResult::failure(error);
    }
    let target = match injector.capture_target() {
        Ok(target) => target,
        Err(error) => return CommandResult::failure(error),
    };

    match injector.inject(&target, &text) {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure(error),
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn normalized_code_point_count(text: &str) -> usize {
    normalize_newlines(text).chars().count()
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::thread;
    use std::time::Duration;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RETURN,
        VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsWindow,
    };

    use super::{
        normalize_newlines, AppError, InjectReport, Instant, TargetWindow, TextInjector,
        INPUTS_PER_BATCH,
    };

    pub struct PlatformTextInjector;

    pub fn wait_for_modifiers_released() -> Result<(), AppError> {
        const ATTEMPTS: usize = 100;
        let modifiers = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];

        for _ in 0..ATTEMPTS {
            let any_pressed = modifiers
                .iter()
                .any(|key| (unsafe { GetAsyncKeyState(i32::from(key.0)) } as u16 & 0x8000) != 0);
            if !any_pressed {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }

        Err(AppError::new(
            "injection_modifiers_pressed",
            "release the recording shortcut before injecting text",
            true,
        ))
    }

    #[derive(Debug)]
    struct PlannedCharacter {
        text_end: usize,
        event_end: usize,
    }

    impl TextInjector for PlatformTextInjector {
        fn capture_target(&self) -> Result<TargetWindow, AppError> {
            let window = unsafe { GetForegroundWindow() };
            if window.0.is_null() || !unsafe { IsWindow(Some(window)) }.as_bool() {
                return Err(AppError::new(
                    "injection_target_unavailable",
                    "no foreground window is available for text injection",
                    true,
                ));
            }

            let mut process_id = 0;
            unsafe {
                GetWindowThreadProcessId(window, Some(&mut process_id));
            }
            if process_id == unsafe { GetCurrentProcessId() } {
                return Err(AppError::new(
                    "injection_target_is_self",
                    "switch to the target application before injecting text",
                    true,
                ));
            }

            Ok(TargetWindow {
                handle: window.0 as isize,
            })
        }

        fn inject(&self, target: &TargetWindow, text: &str) -> Result<InjectReport, AppError> {
            let started_at = Instant::now();
            let normalized = normalize_newlines(text);
            let requested_code_points = normalized.chars().count();
            let target_window = HWND(target.handle as *mut c_void);
            let (events, characters) = build_input_plan(&normalized);
            let mut sent_events = 0usize;
            let mut injected_code_points = 0usize;
            let mut injected_text_end = 0usize;

            while sent_events < events.len() {
                if !unsafe { IsWindow(Some(target_window)) }.as_bool() {
                    return Ok(partial_report(
                        &normalized,
                        requested_code_points,
                        injected_code_points,
                        injected_text_end,
                        started_at,
                        "injection_target_closed",
                    ));
                }
                if unsafe { GetForegroundWindow() }.0 != target_window.0 {
                    return Ok(partial_report(
                        &normalized,
                        requested_code_points,
                        injected_code_points,
                        injected_text_end,
                        started_at,
                        "injection_target_changed",
                    ));
                }

                let batch_limit = (sent_events + INPUTS_PER_BATCH).min(events.len());
                let batch_end = characters[injected_code_points..]
                    .iter()
                    .take_while(|character| character.event_end <= batch_limit)
                    .last()
                    .map_or(characters[injected_code_points].event_end, |character| {
                        character.event_end
                    });
                let batch = &events[sent_events..batch_end];
                let sent = unsafe { SendInput(batch, size_of::<INPUT>() as i32) } as usize;
                sent_events += sent;

                for character in &characters[injected_code_points..] {
                    if character.event_end > sent_events {
                        break;
                    }
                    injected_code_points += 1;
                    injected_text_end = character.text_end;
                }

                if sent < batch.len() {
                    let code = if sent_events == 0 {
                        "injection_blocked"
                    } else {
                        "injection_partial"
                    };
                    if sent_events == 0 {
                        return Err(AppError::new(
                            code,
                            "Windows blocked text injection; the target may be elevated or unsupported",
                            true,
                        ));
                    }
                    return Ok(partial_report(
                        &normalized,
                        requested_code_points,
                        injected_code_points,
                        injected_text_end,
                        started_at,
                        code,
                    ));
                }

                thread::yield_now();
            }

            Ok(InjectReport {
                requested_code_points,
                injected_code_points,
                remaining_text: String::new(),
                elapsed_ms: started_at.elapsed().as_millis(),
                complete: true,
                error_code: None,
            })
        }
    }

    fn partial_report(
        normalized: &str,
        requested_code_points: usize,
        injected_code_points: usize,
        injected_text_end: usize,
        started_at: Instant,
        error_code: &'static str,
    ) -> InjectReport {
        InjectReport {
            requested_code_points,
            injected_code_points,
            remaining_text: normalized[injected_text_end..].to_owned(),
            elapsed_ms: started_at.elapsed().as_millis(),
            complete: false,
            error_code: Some(error_code),
        }
    }

    fn build_input_plan(text: &str) -> (Vec<INPUT>, Vec<PlannedCharacter>) {
        let mut events = Vec::new();
        let mut characters = Vec::with_capacity(text.chars().count());

        for (text_start, character) in text.char_indices() {
            if character == '\n' {
                events.push(key_input(VK_RETURN, 0, KEYBD_EVENT_FLAGS(0)));
                events.push(key_input(VK_RETURN, 0, KEYEVENTF_KEYUP));
            } else {
                let mut utf16 = [0u16; 2];
                for code_unit in character.encode_utf16(&mut utf16).iter().copied() {
                    events.push(key_input(VIRTUAL_KEY(0), code_unit, KEYEVENTF_UNICODE));
                    events.push(key_input(
                        VIRTUAL_KEY(0),
                        code_unit,
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    ));
                }
            }

            characters.push(PlannedCharacter {
                text_end: text_start + character.len_utf8(),
                event_end: events.len(),
            });
        }

        (events, characters)
    }

    fn key_input(key: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    #[cfg(test)]
    mod tests {
        use super::build_input_plan;
        use crate::commands::text_injection::{normalize_newlines, normalized_code_point_count};

        #[test]
        fn normalizes_windows_newlines_and_counts_unicode_scalars() {
            let text = "中\r\nA\remoji😀";
            let normalized = normalize_newlines(text);

            assert_eq!(normalized, "中\nA\nemoji😀");
            assert_eq!(normalized_code_point_count(text), 10);
        }

        #[test]
        fn plans_enter_and_surrogate_pairs_as_complete_characters() {
            let (events, characters) = build_input_plan("A\n😀");

            assert_eq!(events.len(), 8);
            assert_eq!(characters.len(), 3);
            assert_eq!(characters[0].event_end, 2);
            assert_eq!(characters[1].event_end, 4);
            assert_eq!(characters[2].event_end, 8);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::thread;
    use std::time::Duration;

    use core_graphics::event::{CGEvent, CGEventTapLocation, CGKeyCode, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2_app_kit::NSWorkspace;
    use objc2_core_graphics::{CGPreflightPostEventAccess, CGRequestPostEventAccess};

    use super::{normalize_newlines, AppError, InjectReport, Instant, TargetWindow, TextInjector};

    const CHARACTERS_PER_BATCH: usize = 128;

    pub struct PlatformTextInjector;

    pub fn wait_for_modifiers_released() -> Result<(), AppError> {
        const ATTEMPTS: usize = 100;
        const MODIFIERS: [CGKeyCode; 8] = [
            KeyCode::CONTROL,
            KeyCode::RIGHT_CONTROL,
            KeyCode::SHIFT,
            KeyCode::RIGHT_SHIFT,
            KeyCode::OPTION,
            KeyCode::RIGHT_OPTION,
            KeyCode::COMMAND,
            KeyCode::RIGHT_COMMAND,
        ];

        for _ in 0..ATTEMPTS {
            let any_pressed = MODIFIERS.iter().any(|key_code| unsafe {
                CGEventSourceKeyState(CGEventSourceStateID::CombinedSessionState, *key_code)
            });
            if !any_pressed {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }

        Err(AppError::new(
            "injection_modifiers_pressed",
            "release the recording shortcut before injecting text",
            true,
        ))
    }

    impl TextInjector for PlatformTextInjector {
        fn capture_target(&self) -> Result<TargetWindow, AppError> {
            if !CGPreflightPostEventAccess() && !CGRequestPostEventAccess() {
                return Err(AppError::new(
                    "accessibility_required",
                    "macOS Accessibility permission is required for text injection",
                    true,
                ));
            }

            let process_id = frontmost_process_id().ok_or_else(|| {
                AppError::new(
                    "injection_target_unavailable",
                    "no foreground application is available for text injection",
                    true,
                )
            })?;
            if process_id == std::process::id() as i32 {
                return Err(AppError::new(
                    "injection_target_is_self",
                    "switch to the target application before injecting text",
                    true,
                ));
            }

            Ok(TargetWindow {
                handle: process_id as isize,
            })
        }

        fn inject(&self, target: &TargetWindow, text: &str) -> Result<InjectReport, AppError> {
            let started_at = Instant::now();
            let normalized = normalize_newlines(text);
            let requested_code_points = normalized.chars().count();
            let target_process_id = target.handle as i32;
            let mut injected_code_points = 0usize;
            let mut injected_text_end = 0usize;

            for (text_start, character) in normalized.char_indices() {
                if frontmost_process_id() != Some(target_process_id) {
                    return Ok(partial_report(
                        &normalized,
                        requested_code_points,
                        injected_code_points,
                        injected_text_end,
                        started_at,
                        "injection_target_changed",
                    ));
                }

                if let Err(error) = post_character(character) {
                    if injected_code_points == 0 {
                        return Err(error);
                    }
                    return Ok(partial_report(
                        &normalized,
                        requested_code_points,
                        injected_code_points,
                        injected_text_end,
                        started_at,
                        "injection_partial",
                    ));
                }
                injected_code_points += 1;
                injected_text_end = text_start + character.len_utf8();

                if injected_code_points.is_multiple_of(CHARACTERS_PER_BATCH) {
                    thread::yield_now();
                }
            }

            Ok(InjectReport {
                requested_code_points,
                injected_code_points,
                remaining_text: String::new(),
                elapsed_ms: started_at.elapsed().as_millis(),
                complete: true,
                error_code: None,
            })
        }
    }

    fn frontmost_process_id() -> Option<i32> {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|application| application.processIdentifier())
            .filter(|process_id| *process_id > 0)
    }

    fn post_character(character: char) -> Result<(), AppError> {
        let source =
            CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|_| {
                AppError::new(
                    "injection_unavailable",
                    "unable to create a macOS keyboard event source",
                    true,
                )
            })?;
        let key_code = if character == '\n' {
            KeyCode::RETURN
        } else {
            KeyCode::ANSI_A
        };
        let key_down =
            CGEvent::new_keyboard_event(source.clone(), key_code, true).map_err(|_| {
                AppError::new(
                    "injection_unavailable",
                    "unable to create a macOS key-down event",
                    true,
                )
            })?;
        let key_up = CGEvent::new_keyboard_event(source, key_code, false).map_err(|_| {
            AppError::new(
                "injection_unavailable",
                "unable to create a macOS key-up event",
                true,
            )
        })?;

        if character != '\n' {
            let text = character.to_string();
            key_down.set_string(&text);
        }
        key_down.post(CGEventTapLocation::HID);
        key_up.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn partial_report(
        normalized: &str,
        requested_code_points: usize,
        injected_code_points: usize,
        injected_text_end: usize,
        started_at: Instant,
        error_code: &'static str,
    ) -> InjectReport {
        InjectReport {
            requested_code_points,
            injected_code_points,
            remaining_text: normalized[injected_text_end..].to_owned(),
            elapsed_ms: started_at.elapsed().as_millis(),
            complete: false,
            error_code: Some(error_code),
        }
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceKeyState(state_id: CGEventSourceStateID, key_code: CGKeyCode) -> bool;
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{AppError, InjectReport, TargetWindow, TextInjector};

    pub struct PlatformTextInjector;

    pub fn wait_for_modifiers_released() -> Result<(), AppError> {
        Ok(())
    }

    impl TextInjector for PlatformTextInjector {
        fn capture_target(&self) -> Result<TargetWindow, AppError> {
            Err(AppError::new(
                "unsupported_platform",
                "text injection is only implemented for Windows",
                false,
            ))
        }

        fn inject(&self, _target: &TargetWindow, _text: &str) -> Result<InjectReport, AppError> {
            Err(AppError::new(
                "unsupported_platform",
                "text injection is only implemented for Windows",
                false,
            ))
        }
    }
}
