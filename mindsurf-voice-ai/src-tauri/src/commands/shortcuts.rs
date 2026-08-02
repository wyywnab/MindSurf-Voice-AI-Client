use serde::{Deserialize, Serialize};

use crate::error::{AppError, CommandResult};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ShortcutBinding(String);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedShortcutBinding {
    shift: bool,
    control: bool,
    alt: bool,
    super_key: bool,
    code: Option<String>,
}

impl ShortcutBinding {
    fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    fn parse(&self) -> Result<ParsedShortcutBinding, AppError> {
        parse_binding(&self.0)
    }

    fn display(&self) -> String {
        let labels = self.0.split('+').map(|part| match part {
            "shift" => "Shift".to_owned(),
            "control" if cfg!(target_os = "macos") => "Control".to_owned(),
            "control" => "Ctrl".to_owned(),
            "alt" if cfg!(target_os = "macos") => "Option".to_owned(),
            "alt" => "Alt".to_owned(),
            "super" if cfg!(target_os = "macos") => "Command".to_owned(),
            "super" if cfg!(target_os = "windows") => "Win".to_owned(),
            "super" => "Super".to_owned(),
            "Space" => "Space".to_owned(),
            code => code.strip_prefix("Key").unwrap_or(code).to_owned(),
        });
        labels.collect::<Vec<_>>().join(" + ")
    }

    fn canonical_value(&self) -> &str {
        &self.0
    }
}

impl Default for ShortcutBinding {
    fn default() -> Self {
        if cfg!(target_os = "macos") {
            Self::new("control+super+Space")
        } else {
            Self::new("control+super")
        }
    }
}

impl Default for ParsedShortcutBinding {
    fn default() -> Self {
        Self {
            shift: false,
            control: true,
            alt: false,
            super_key: true,
            code: None,
        }
    }
}

fn parse_binding(value: &str) -> Result<ParsedShortcutBinding, AppError> {
    let mut parsed = ParsedShortcutBinding {
        shift: false,
        control: false,
        alt: false,
        super_key: false,
        code: None,
    };
    for part in value.split('+') {
        match part {
            "shift" if !parsed.shift => parsed.shift = true,
            "control" if !parsed.control => parsed.control = true,
            "alt" if !parsed.alt => parsed.alt = true,
            "super" if !parsed.super_key => parsed.super_key = true,
            code if parsed.code.is_none() && valid_key_code(code) => {
                parsed.code = Some(code.to_owned())
            }
            _ => {
                return Err(shortcut_error(
                    "shortcut_invalid",
                    "shortcut format is invalid",
                ))
            }
        }
    }
    let modifier_count = [parsed.shift, parsed.control, parsed.alt, parsed.super_key]
        .into_iter()
        .filter(|enabled| *enabled)
        .count();
    if modifier_count == 0 {
        return Err(shortcut_error(
            "shortcut_modifier_required",
            "shortcut must include a modifier",
        ));
    }
    if parsed.code.is_none() && modifier_count < 2 {
        return Err(shortcut_error(
            "shortcut_modifier_only_invalid",
            "modifier-only shortcuts require at least two modifiers",
        ));
    }
    let mut canonical = Vec::new();
    if parsed.shift {
        canonical.push("shift");
    }
    if parsed.control {
        canonical.push("control");
    }
    if parsed.alt {
        canonical.push("alt");
    }
    if parsed.super_key {
        canonical.push("super");
    }
    if let Some(code) = parsed.code.as_deref() {
        canonical.push(code);
    }
    if canonical.join("+") != value {
        return Err(shortcut_error(
            "shortcut_invalid",
            "shortcut must use canonical modifier ordering",
        ));
    }
    Ok(parsed)
}

fn valid_key_code(code: &str) -> bool {
    matches!(
        code,
        "Space"
            | "Enter"
            | "Tab"
            | "Backspace"
            | "Delete"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Comma"
            | "Period"
            | "Slash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backslash"
            | "Minus"
            | "Equal"
    ) || code
        .strip_prefix("Key")
        .is_some_and(|key| key.len() == 1 && key.as_bytes()[0].is_ascii_uppercase())
        || code
            .strip_prefix("Digit")
            .is_some_and(|key| key.len() == 1 && key.as_bytes()[0].is_ascii_digit())
        || code
            .strip_prefix('F')
            .and_then(|key| key.parse::<u8>().ok())
            .is_some_and(|key| (1..=12).contains(&key))
}

fn shortcut_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message, true)
}

fn validate_system_reserved(binding: &ShortcutBinding) -> Result<(), AppError> {
    let reserved = if cfg!(target_os = "macos") {
        matches!(
            binding.canonical_value(),
            "super+KeyQ" | "super+Space" | "control+super+KeyQ"
        )
    } else if cfg!(target_os = "windows") {
        matches!(
            binding.canonical_value(),
            "alt+F4" | "super+KeyL" | "control+alt+Delete"
        )
    } else {
        binding.canonical_value() == "control+alt+Delete"
    };
    if reserved {
        Err(shortcut_error(
            "shortcut_system_reserved",
            "shortcut is reserved by the operating system",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod binding_tests {
    use super::{parse_binding, validate_system_reserved, ShortcutBinding};

    #[test]
    fn parses_canonical_arbitrary_binding() {
        let parsed = parse_binding("shift+control+KeyR").expect("binding should parse");
        assert!(parsed.shift);
        assert!(parsed.control);
        assert_eq!(parsed.code.as_deref(), Some("KeyR"));
    }

    #[test]
    fn rejects_non_canonical_modifier_order() {
        let error = parse_binding("control+shift+KeyR").expect_err("binding should fail");
        assert_eq!(error.code, "shortcut_invalid");
    }

    #[test]
    fn rejects_platform_reserved_binding_with_stable_code() {
        let binding = if cfg!(target_os = "macos") {
            ShortcutBinding::new("super+KeyQ")
        } else if cfg!(target_os = "windows") {
            ShortcutBinding::new("alt+F4")
        } else {
            ShortcutBinding::new("control+alt+Delete")
        };
        let error = validate_system_reserved(&binding).expect_err("binding should be reserved");
        assert_eq!(error.code, "shortcut_system_reserved");
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    binding: ShortcutBinding,
    display: String,
    enabled: bool,
    listener_status: &'static str,
    last_error: Option<String>,
    environment: &'static str,
    supports_modifier_only: bool,
}

#[derive(Clone, Serialize)]
struct RecordShortcutPayload {
    shortcut: String,
    timestamp_ms: u64,
}

#[derive(Clone, Serialize)]
#[cfg(target_os = "windows")]
struct CancelShortcutPayload {
    timestamp_ms: u64,
}

pub fn initialize(app: tauri::AppHandle) {
    platform::initialize(app);
}

pub fn handle_global_shortcut(
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    platform::handle_global_shortcut(shortcut, event);
}

#[tauri::command]
pub fn get_record_shortcut_status() -> CommandResult<ShortcutStatus> {
    match platform::status() {
        Ok(status) => CommandResult::success(status),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn register_record_shortcut(binding: ShortcutBinding) -> CommandResult<ShortcutStatus> {
    #[cfg(debug_assertions)]
    eprintln!("shortcut command: register ({})", binding.display());
    if let Err(error) = binding.parse() {
        return CommandResult::failure(error);
    }
    if let Err(error) = validate_system_reserved(&binding) {
        return CommandResult::failure(error);
    }
    match platform::register(binding) {
        Ok(status) => CommandResult::success(status),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn unregister_record_shortcut() -> CommandResult<ShortcutStatus> {
    #[cfg(debug_assertions)]
    eprintln!("shortcut command: unregister");
    match platform::unregister() {
        Ok(status) => CommandResult::success(status),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn report_shortcut_event_handled(
    phase: String,
    can_start: bool,
    recorder_state: String,
    request_status: String,
) {
    #[cfg(debug_assertions)]
    eprintln!(
        "shortcut frontend: {phase}, can_start={can_start}, recorder={recorder_state}, request={request_status}"
    );
    #[cfg(not(debug_assertions))]
    let _ = (phase, can_start, recorder_state, request_status);
}

#[cfg(target_os = "windows")]
mod platform {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{Mutex, OnceLock, RwLock};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::Emitter;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
        MOD_SHIFT, MOD_WIN, VIRTUAL_KEY, VK_ESCAPE, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
        VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use super::{
        AppError, CancelShortcutPayload, RecordShortcutPayload, ShortcutBinding, ShortcutStatus,
    };

    const LISTENER_STARTING: u8 = 0;
    const LISTENER_RUNNING: u8 = 1;
    const LISTENER_ERROR: u8 = 2;
    const HOTKEY_PROBE_ID: i32 = 0x4d53;
    static STATE: OnceLock<ShortcutState> = OnceLock::new();
    static HOTKEY_PROBE_LOCK: Mutex<()> = Mutex::new(());

    struct ShortcutState {
        app: tauri::AppHandle,
        binding: RwLock<ShortcutBinding>,
        enabled: AtomicBool,
        active: AtomicBool,
        pressed: Mutex<HashSet<u32>>,
        listener_status: AtomicU8,
        last_error: Mutex<Option<String>>,
    }

    pub fn initialize(app: tauri::AppHandle) {
        if STATE
            .set(ShortcutState {
                app,
                binding: RwLock::new(ShortcutBinding::default()),
                enabled: AtomicBool::new(true),
                active: AtomicBool::new(false),
                pressed: Mutex::new(HashSet::new()),
                listener_status: AtomicU8::new(LISTENER_STARTING),
                last_error: Mutex::new(None),
            })
            .is_err()
        {
            return;
        }

        thread::spawn(run_keyboard_hook);
    }

    pub fn handle_global_shortcut(
        _shortcut: &tauri_plugin_global_shortcut::Shortcut,
        _event: tauri_plugin_global_shortcut::ShortcutEvent,
    ) {
    }

    pub fn status() -> Result<ShortcutStatus, AppError> {
        let state = state()?;
        let binding = state
            .binding
            .read()
            .map_err(|_| {
                shortcut_error(
                    "shortcut_state_unavailable",
                    "shortcut state is unavailable",
                )
            })?
            .clone();
        let last_error = state
            .last_error
            .lock()
            .map_err(|_| {
                shortcut_error(
                    "shortcut_state_unavailable",
                    "shortcut state is unavailable",
                )
            })?
            .clone();

        let display = binding.display();
        Ok(ShortcutStatus {
            binding,
            display,
            enabled: state.enabled.load(Ordering::Acquire),
            listener_status: listener_status_label(state.listener_status.load(Ordering::Acquire)),
            last_error,
            environment: "windows",
            supports_modifier_only: true,
        })
    }

    pub fn register(binding: ShortcutBinding) -> Result<ShortcutStatus, AppError> {
        probe_conflict(&binding)?;
        let state = state()?;
        if state.listener_status.load(Ordering::Acquire) == LISTENER_ERROR {
            return Err(shortcut_error(
                "shortcut_listener_unavailable",
                state
                    .last_error
                    .lock()
                    .ok()
                    .and_then(|error| error.clone())
                    .unwrap_or_else(|| "global keyboard listener is unavailable".to_owned()),
            ));
        }

        release_if_active(state);
        *state.binding.write().map_err(|_| {
            shortcut_error(
                "shortcut_state_unavailable",
                "shortcut state is unavailable",
            )
        })? = binding;
        state.enabled.store(true, Ordering::Release);
        if state.listener_status.load(Ordering::Acquire) != LISTENER_ERROR {
            if let Ok(mut error) = state.last_error.lock() {
                *error = None;
            }
        }
        status()
    }

    pub fn unregister() -> Result<ShortcutStatus, AppError> {
        let state = state()?;
        release_if_active(state);
        state.enabled.store(false, Ordering::Release);
        status()
    }

    fn run_keyboard_hook() {
        let Some(state) = STATE.get() else {
            return;
        };
        let module = unsafe { GetModuleHandleW(None) }.ok();
        let instance = module.map(|module| HINSTANCE(module.0));
        let hook = match unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), instance, 0)
        } {
            Ok(hook) => hook,
            Err(_) => {
                state
                    .listener_status
                    .store(LISTENER_ERROR, Ordering::Release);
                if let Ok(mut error) = state.last_error.lock() {
                    *error =
                        Some("Windows global keyboard listener could not be installed".to_owned());
                }
                return;
            }
        };

        state
            .listener_status
            .store(LISTENER_RUNNING, Ordering::Release);
        #[cfg(debug_assertions)]
        eprintln!("global shortcut listener running");

        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        let _ = unsafe { UnhookWindowsHookEx(hook) };
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let message = wparam.0 as u32;
            let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
            if is_down || is_up {
                let keyboard = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
                handle_key_event(keyboard.vkCode, is_down);
            }
        }

        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn handle_key_event(virtual_key: u32, is_down: bool) {
        let Some(state) = STATE.get() else {
            return;
        };
        let Ok(mut pressed) = state.pressed.lock() else {
            return;
        };
        let was_pressed = pressed.contains(&virtual_key);
        if is_down {
            pressed.insert(virtual_key);
        } else {
            pressed.remove(&virtual_key);
        }

        if virtual_key == key(VK_ESCAPE) && is_down && !was_pressed {
            #[cfg(debug_assertions)]
            eprintln!("shortcut event: cancel");
            let _ = state.app.emit(
                "shortcut://cancel",
                CancelShortcutPayload {
                    timestamp_ms: timestamp_ms(),
                },
            );
        }

        if !state.enabled.load(Ordering::Acquire) {
            return;
        }
        let Ok(binding) = state.binding.read().map(|binding| binding.clone()) else {
            return;
        };
        let matches = binding_matches(&binding, &pressed);
        let active = state.active.load(Ordering::Acquire);

        if matches && !active {
            state.active.store(true, Ordering::Release);
            #[cfg(debug_assertions)]
            eprintln!("shortcut event: record-pressed ({})", binding.display());
            let _ = state.app.emit(
                "shortcut://record-pressed",
                RecordShortcutPayload {
                    shortcut: binding.display(),
                    timestamp_ms: timestamp_ms(),
                },
            );
        } else if !matches && active {
            state.active.store(false, Ordering::Release);
            #[cfg(debug_assertions)]
            eprintln!("shortcut event: record-released ({})", binding.display());
            let _ = state.app.emit(
                "shortcut://record-released",
                RecordShortcutPayload {
                    shortcut: binding.display(),
                    timestamp_ms: timestamp_ms(),
                },
            );
        }
    }

    fn binding_matches(binding: &ShortcutBinding, pressed: &HashSet<u32>) -> bool {
        let parsed = binding.parse().unwrap_or_default();
        let ctrl = pressed_any(pressed, &[VK_LCONTROL, VK_RCONTROL]);
        let alt = pressed_any(pressed, &[VK_LMENU, VK_RMENU]);
        let shift = pressed_any(pressed, &[VK_LSHIFT, VK_RSHIFT]);
        let windows = pressed_any(pressed, &[VK_LWIN, VK_RWIN]);
        let terminal_key = parsed.code.as_deref().and_then(virtual_key_for_code);
        ctrl == parsed.control
            && alt == parsed.alt
            && shift == parsed.shift
            && windows == parsed.super_key
            && terminal_key.is_none_or(|terminal| pressed.contains(&terminal))
            && pressed.iter().all(|pressed_key| {
                is_modifier_key(*pressed_key) || terminal_key == Some(*pressed_key)
            })
    }

    fn pressed_any(pressed: &HashSet<u32>, keys: &[VIRTUAL_KEY]) -> bool {
        keys.iter()
            .any(|virtual_key| pressed.contains(&key(*virtual_key)))
    }

    fn key(virtual_key: VIRTUAL_KEY) -> u32 {
        u32::from(virtual_key.0)
    }

    fn release_if_active(state: &ShortcutState) {
        if state.active.swap(false, Ordering::AcqRel) {
            let binding = state
                .binding
                .read()
                .map(|binding| binding.clone())
                .unwrap_or_default();
            let _ = state.app.emit(
                "shortcut://record-released",
                RecordShortcutPayload {
                    shortcut: binding.display(),
                    timestamp_ms: timestamp_ms(),
                },
            );
        }
    }

    fn probe_conflict(binding: &ShortcutBinding) -> Result<(), AppError> {
        let Some((modifiers, virtual_key)) = registration_probe(binding) else {
            return Ok(());
        };
        let _guard = HOTKEY_PROBE_LOCK.lock().map_err(|_| {
            shortcut_error(
                "shortcut_state_unavailable",
                "shortcut state is unavailable",
            )
        })?;

        if unsafe { RegisterHotKey(None, HOTKEY_PROBE_ID, modifiers, virtual_key) }.is_err() {
            return Err(shortcut_error(
                "shortcut_conflict",
                format!(
                    "{} is already reserved by Windows or another application",
                    binding.display()
                ),
            ));
        }
        let _ = unsafe { UnregisterHotKey(None, HOTKEY_PROBE_ID) };
        Ok(())
    }

    fn registration_probe(binding: &ShortcutBinding) -> Option<(HOT_KEY_MODIFIERS, u32)> {
        let parsed = binding.parse().ok()?;
        let virtual_key = parsed.code.as_deref().and_then(virtual_key_for_code)?;
        let mut modifiers = MOD_NOREPEAT;
        if parsed.control {
            modifiers |= MOD_CONTROL;
        }
        if parsed.alt {
            modifiers |= MOD_ALT;
        }
        if parsed.shift {
            modifiers |= MOD_SHIFT;
        }
        if parsed.super_key {
            modifiers |= MOD_WIN;
        }
        Some((modifiers, virtual_key))
    }

    fn virtual_key_for_code(code: &str) -> Option<u32> {
        if let Some(letter) = code.strip_prefix("Key") {
            return letter.as_bytes().first().copied().map(u32::from);
        }
        if let Some(digit) = code.strip_prefix("Digit") {
            return digit.as_bytes().first().copied().map(u32::from);
        }
        if let Some(function) = code
            .strip_prefix('F')
            .and_then(|value| value.parse::<u32>().ok())
        {
            return (1..=12).contains(&function).then_some(0x70 + function - 1);
        }
        Some(match code {
            "Space" => 0x20,
            "Enter" => 0x0d,
            "Tab" => 0x09,
            "Backspace" => 0x08,
            "Delete" => 0x2e,
            "Home" => 0x24,
            "End" => 0x23,
            "PageUp" => 0x21,
            "PageDown" => 0x22,
            "ArrowLeft" => 0x25,
            "ArrowUp" => 0x26,
            "ArrowRight" => 0x27,
            "ArrowDown" => 0x28,
            "Comma" => 0xbc,
            "Period" => 0xbe,
            "Slash" => 0xbf,
            "Semicolon" => 0xba,
            "Quote" => 0xde,
            "BracketLeft" => 0xdb,
            "BracketRight" => 0xdd,
            "Backslash" => 0xdc,
            "Minus" => 0xbd,
            "Equal" => 0xbb,
            _ => return None,
        })
    }

    fn is_modifier_key(virtual_key: u32) -> bool {
        [
            VK_LCONTROL,
            VK_RCONTROL,
            VK_LMENU,
            VK_RMENU,
            VK_LSHIFT,
            VK_RSHIFT,
            VK_LWIN,
            VK_RWIN,
        ]
        .into_iter()
        .map(key)
        .any(|modifier| modifier == virtual_key)
    }

    fn state() -> Result<&'static ShortcutState, AppError> {
        STATE.get().ok_or_else(|| {
            shortcut_error(
                "shortcut_listener_unavailable",
                "global shortcut listener is not initialized",
            )
        })
    }

    fn listener_status_label(status: u8) -> &'static str {
        match status {
            LISTENER_RUNNING => "running",
            LISTENER_ERROR => "error",
            _ => "starting",
        }
    }

    fn shortcut_error(code: &str, message: impl Into<String>) -> AppError {
        AppError::new(code, message, true)
    }

    fn timestamp_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }

    #[cfg(test)]
    mod tests {
        use std::collections::HashSet;

        use windows::Win32::UI::Input::KeyboardAndMouse::{
            VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_SPACE,
        };

        use super::{binding_matches, key, ShortcutBinding};

        #[test]
        fn modifier_only_binding_starts_when_ctrl_and_win_are_down() {
            let pressed = HashSet::from([key(VK_LCONTROL), key(VK_LWIN)]);
            assert!(binding_matches(
                &ShortcutBinding::new("control+super"),
                &pressed
            ));
        }

        #[test]
        fn extra_modifier_does_not_trigger_binding() {
            let pressed = HashSet::from([key(VK_LCONTROL), key(VK_LWIN), key(VK_LSHIFT)]);
            assert!(!binding_matches(
                &ShortcutBinding::new("control+super"),
                &pressed
            ));
        }

        #[test]
        fn configurable_binding_requires_its_terminal_key() {
            let without_space = HashSet::from([key(VK_LCONTROL), key(VK_LMENU)]);
            let with_space = HashSet::from([key(VK_LCONTROL), key(VK_LMENU), key(VK_SPACE)]);

            let binding = ShortcutBinding::new("control+alt+Space");
            assert!(!binding_matches(&binding, &without_space));
            assert!(binding_matches(&binding, &with_space));
        }
    }
}

#[cfg(target_os = "macos")]
#[path = "shortcuts_macos.rs"]
mod platform;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{AppError, ShortcutBinding, ShortcutStatus};

    pub fn initialize(_app: tauri::AppHandle) {}

    pub fn handle_global_shortcut(
        _shortcut: &tauri_plugin_global_shortcut::Shortcut,
        _event: tauri_plugin_global_shortcut::ShortcutEvent,
    ) {
    }

    pub fn status() -> Result<ShortcutStatus, AppError> {
        Err(unsupported())
    }

    pub fn register(_binding: ShortcutBinding) -> Result<ShortcutStatus, AppError> {
        Err(unsupported())
    }

    pub fn unregister() -> Result<ShortcutStatus, AppError> {
        Err(unsupported())
    }

    fn unsupported() -> AppError {
        AppError::new(
            "unsupported_platform",
            "global shortcuts are only implemented for Windows and macOS",
            false,
        )
    }
}
