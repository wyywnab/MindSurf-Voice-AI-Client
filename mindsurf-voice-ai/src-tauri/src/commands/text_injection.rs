use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

use crate::error::{AppError, CommandResult};

const DEFAULT_MAX_CODE_POINTS: usize = 8_000;
#[cfg(target_os = "windows")]
const INPUTS_PER_BATCH: usize = 256;
static INJECTION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq, Eq)]
pub struct TargetWindow {
    handle: isize,
    #[cfg(target_os = "macos")]
    focused_element: core_foundation::base::CFTypeRef,
    #[cfg(target_os = "macos")]
    allow_self_frontmost: bool,
}

#[cfg(target_os = "macos")]
impl Drop for TargetWindow {
    fn drop(&mut self) {
        if !self.focused_element.is_null() {
            unsafe {
                core_foundation::base::CFRelease(self.focused_element);
            }
        }
    }
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
pub fn prepare_text_injection_target(_app: tauri::AppHandle) -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    if let Err(error) = platform::prepare_target(&_app) {
        #[cfg(debug_assertions)]
        eprintln!(
            "text injection: target preparation failed code={}, message={}",
            error.code, error.message
        );
        return CommandResult::failure(error);
    }

    CommandResult::success(())
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
    #[cfg(debug_assertions)]
    eprintln!("text injection: command requested code_points={requested_code_points}");
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
        #[cfg(debug_assertions)]
        eprintln!(
            "text injection: modifier wait failed code={}, message={}",
            error.code, error.message
        );
        return CommandResult::failure(error);
    }
    #[cfg(target_os = "macos")]
    let captured_target = platform::capture_prepared_target(&injector);
    #[cfg(not(target_os = "macos"))]
    let captured_target = injector.capture_target();
    let target = match captured_target {
        Ok(target) => target,
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "text injection: target capture failed code={}, message={}",
                error.code, error.message
            );
            return CommandResult::failure(error);
        }
    };

    match injector.inject(&target, &text) {
        Ok(report) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "text injection: finished complete={}, injected={}/{} error={:?}",
                report.complete,
                report.injected_code_points,
                report.requested_code_points,
                report.error_code
            );
            CommandResult::success(report)
        }
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "text injection: failed code={}, message={}",
                error.code, error.message
            );
            CommandResult::failure(error)
        }
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
    use std::ptr;
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{CGEvent, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWorkspace};

    use super::{normalize_newlines, AppError, InjectReport, Instant, TargetWindow, TextInjector};

    const CHARACTERS_PER_BATCH: usize = 128;
    const PREPARED_TARGET_MAX_AGE_MS: u64 = 120_000;
    static PREPARED_TARGET: Mutex<Option<PreparedTarget>> = Mutex::new(None);

    struct PreparedTarget {
        process_id: i32,
        focused_element: CFTypeRef,
        prepared_at_ms: u64,
    }

    // AXUIElementRef is an immutable Core Foundation reference. Ownership is
    // retained by this value and transferred to TargetWindow before injection.
    unsafe impl Send for PreparedTarget {}

    impl Drop for PreparedTarget {
        fn drop(&mut self) {
            if !self.focused_element.is_null() {
                unsafe {
                    CFRelease(self.focused_element);
                }
            }
        }
    }

    pub struct PlatformTextInjector;

    pub fn prepare_target(app: &tauri::AppHandle) -> Result<(), AppError> {
        *PREPARED_TARGET.lock().map_err(|_| target_state_error())? = None;

        if frontmost_process_id() == Some(std::process::id() as i32) {
            yield_focus(app)?;
        }

        for _ in 0..50 {
            if let Some(process_id) =
                frontmost_process_id().filter(|pid| *pid != std::process::id() as i32)
            {
                let focused_element = focused_element_for_process(process_id);
                *PREPARED_TARGET.lock().map_err(|_| target_state_error())? = Some(PreparedTarget {
                    process_id,
                    focused_element,
                    prepared_at_ms: timestamp_ms(),
                });
                #[cfg(debug_assertions)]
                if focused_element.is_null() {
                    eprintln!(
                        "text injection: prepared target pid={process_id} without AX element"
                    );
                } else {
                    eprintln!("text injection: prepared target pid={process_id} with AX element");
                }
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }

        Err(AppError::new(
            "injection_target_unavailable",
            "the foreground application has no focused accessibility element",
            true,
        ))
    }

    fn yield_focus(app: &tauri::AppHandle) -> Result<(), AppError> {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).deactivate();
            return Ok(());
        }

        app.run_on_main_thread(|| {
            if let Some(mtm) = MainThreadMarker::new() {
                NSApplication::sharedApplication(mtm).deactivate();
            }
        })
        .map_err(|error| {
            AppError::new(
                "injection_target_unavailable",
                format!("unable to yield application focus: {error}"),
                true,
            )
        })
    }

    pub fn capture_prepared_target(
        injector: &PlatformTextInjector,
    ) -> Result<TargetWindow, AppError> {
        let prepared = PREPARED_TARGET
            .lock()
            .map_err(|_| target_state_error())?
            .take();
        let current_process_id = frontmost_process_id();
        let self_process_id = std::process::id() as i32;
        if let Some(mut prepared) = prepared {
            let prepared_is_fresh = timestamp_ms().saturating_sub(prepared.prepared_at_ms)
                <= PREPARED_TARGET_MAX_AGE_MS;
            let prepared_is_current = current_process_id == Some(prepared.process_id);
            let mindsurf_became_frontmost = current_process_id == Some(self_process_id);

            if prepared_is_fresh && (prepared_is_current || mindsurf_became_frontmost) {
                let focused_element = prepared.focused_element;
                prepared.focused_element = ptr::null();
                #[cfg(debug_assertions)]
                eprintln!(
                    "text injection: using captured element pid={}, frontmost={current_process_id:?}",
                    prepared.process_id
                );
                return Ok(TargetWindow {
                    handle: prepared.process_id as isize,
                    focused_element,
                    allow_self_frontmost: mindsurf_became_frontmost,
                });
            }

            #[cfg(debug_assertions)]
            eprintln!(
                "text injection: captured element rejected pid={}, fresh={prepared_is_fresh}, frontmost={current_process_id:?}",
                prepared.process_id
            );
        } else {
            #[cfg(debug_assertions)]
            eprintln!("text injection: no captured element, using current foreground target");
        }
        injector.capture_target()
    }

    pub fn wait_for_modifiers_released() -> Result<(), AppError> {
        // The Carbon hotkey release event already guarantees the terminal key
        // is up. Querying global modifier state would require Input Monitoring,
        // which text injection must not depend on.
        thread::sleep(Duration::from_millis(40));
        Ok(())
    }

    impl TextInjector for PlatformTextInjector {
        fn capture_target(&self) -> Result<TargetWindow, AppError> {
            if !crate::commands::permissions::accessibility_is_trusted() {
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
            let focused_element = focused_element_for_process(process_id);

            Ok(TargetWindow {
                handle: process_id as isize,
                focused_element,
                allow_self_frontmost: false,
            })
        }

        fn inject(&self, target: &TargetWindow, text: &str) -> Result<InjectReport, AppError> {
            let started_at = Instant::now();
            let normalized = normalize_newlines(text);
            let requested_code_points = normalized.chars().count();
            let target_process_id = target.handle as i32;
            let mut injected_code_points = 0usize;
            let mut injected_text_end = 0usize;

            let current_frontmost_process_id = frontmost_process_id();
            let target_is_active = current_frontmost_process_id == Some(target_process_id)
                || (target.allow_self_frontmost
                    && current_frontmost_process_id == Some(std::process::id() as i32));
            if !target_is_active {
                return Ok(partial_report(
                    &normalized,
                    requested_code_points,
                    0,
                    0,
                    started_at,
                    "injection_target_changed",
                ));
            }

            if !target.focused_element.is_null()
                && set_selected_text(target.focused_element, &normalized)
            {
                #[cfg(debug_assertions)]
                eprintln!(
                    "text injection: AXSelectedText succeeded pid={target_process_id}, code_points={requested_code_points}"
                );
                return Ok(InjectReport {
                    requested_code_points,
                    injected_code_points: requested_code_points,
                    remaining_text: String::new(),
                    elapsed_ms: started_at.elapsed().as_millis(),
                    complete: true,
                    error_code: None,
                });
            }

            #[cfg(debug_assertions)]
            eprintln!(
                "text injection: AXSelectedText unavailable, falling back to CGEvent pid={target_process_id}"
            );
            let event_source = create_event_source()?;
            for (text_start, character) in normalized.char_indices() {
                let frontmost_process_id = frontmost_process_id();
                let target_is_active = frontmost_process_id == Some(target_process_id)
                    || (target.allow_self_frontmost
                        && frontmost_process_id == Some(std::process::id() as i32));
                if !target_is_active {
                    return Ok(partial_report(
                        &normalized,
                        requested_code_points,
                        injected_code_points,
                        injected_text_end,
                        started_at,
                        "injection_target_changed",
                    ));
                }
                if let Err(error) = post_character(&event_source, target_process_id, character) {
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

    fn target_state_error() -> AppError {
        AppError::new(
            "injection_unavailable",
            "the prepared text injection target is unavailable",
            true,
        )
    }

    fn system_focused_ui_element() -> Option<(i32, CFTypeRef)> {
        let system_wide = unsafe { AXUIElementCreateSystemWide() };
        if system_wide.is_null() {
            return None;
        }

        let focused_attribute = CFString::new("AXFocusedUIElement");
        let mut focused_element = ptr::null();
        let result = unsafe {
            AXUIElementCopyAttributeValue(
                system_wide,
                focused_attribute.as_concrete_TypeRef(),
                &mut focused_element,
            )
        };
        unsafe {
            CFRelease(system_wide);
        }
        if result != 0 || focused_element.is_null() {
            #[cfg(debug_assertions)]
            eprintln!("text injection: system focused element unavailable ax_error={result}");
            return None;
        }

        let mut process_id = 0i32;
        let pid_result = unsafe { AXUIElementGetPid(focused_element, &mut process_id) };
        if pid_result != 0 || process_id <= 0 {
            #[cfg(debug_assertions)]
            eprintln!("text injection: focused element pid unavailable ax_error={pid_result}");
            unsafe {
                CFRelease(focused_element);
            }
            return None;
        }
        Some((process_id, focused_element))
    }

    fn focused_element_for_process(process_id: i32) -> CFTypeRef {
        match system_focused_ui_element() {
            Some((focused_process_id, element)) if focused_process_id == process_id => element,
            Some((_, element)) => {
                unsafe {
                    CFRelease(element);
                }
                ptr::null()
            }
            None => ptr::null(),
        }
    }

    fn set_selected_text(element: CFTypeRef, text: &str) -> bool {
        let selected_text_attribute = CFString::new("AXSelectedText");
        let mut settable = 0u8;
        let settable_result = unsafe {
            AXUIElementIsAttributeSettable(
                element,
                selected_text_attribute.as_concrete_TypeRef(),
                &mut settable,
            )
        };
        if settable_result != 0 || settable == 0 {
            return false;
        }

        let value = CFString::new(text);
        unsafe {
            AXUIElementSetAttributeValue(
                element,
                selected_text_attribute.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            ) == 0
        }
    }

    fn create_event_source() -> Result<CGEventSource, AppError> {
        CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|_| {
            AppError::new(
                "injection_unavailable",
                "unable to create a macOS keyboard event source",
                true,
            )
        })
    }

    fn post_character(
        source: &CGEventSource,
        process_id: i32,
        character: char,
    ) -> Result<(), AppError> {
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
        let key_up =
            CGEvent::new_keyboard_event(source.clone(), key_code, false).map_err(|_| {
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
        key_down.post_to_pid(process_id);
        key_up.post_to_pid(process_id);
        Ok(())
    }

    fn timestamp_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
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

    #[cfg(test)]
    mod tests {
        use std::time::Instant;

        use super::partial_report;

        #[test]
        fn preserves_unicode_remainder_for_long_injections() {
            for requested_code_points in [500, 2_000, 8_000] {
                let text: String = "中A😀\n"
                    .chars()
                    .cycle()
                    .take(requested_code_points)
                    .collect();
                let injected_code_points = requested_code_points / 2;
                let injected_text_end = text
                    .char_indices()
                    .nth(injected_code_points)
                    .map_or(text.len(), |(index, _)| index);

                let report = partial_report(
                    &text,
                    requested_code_points,
                    injected_code_points,
                    injected_text_end,
                    Instant::now(),
                    "injection_partial",
                );

                assert_eq!(report.requested_code_points, requested_code_points);
                assert_eq!(report.injected_code_points, injected_code_points);
                assert_eq!(
                    report.remaining_text.chars().count(),
                    requested_code_points - injected_code_points
                );
                assert_eq!(report.error_code, Some("injection_partial"));
                assert!(!report.complete);
            }
        }
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementGetPid(element: CFTypeRef, process_id: *mut i32) -> i32;
        fn AXUIElementCopyAttributeValue(
            element: CFTypeRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementIsAttributeSettable(
            element: CFTypeRef,
            attribute: CFStringRef,
            settable: *mut u8,
        ) -> i32;
        fn AXUIElementSetAttributeValue(
            element: CFTypeRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> i32;
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
