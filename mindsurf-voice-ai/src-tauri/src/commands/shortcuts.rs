use serde::{Deserialize, Serialize};

use crate::error::{AppError, CommandResult};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutBinding {
    #[serde(rename = "ctrl_win")]
    #[default]
    Win,
    #[serde(rename = "ctrl_alt_space")]
    AltSpace,
    #[serde(rename = "ctrl_shift_space")]
    ShiftSpace,
    #[serde(rename = "ctrl_win_space")]
    WinSpace,
}

impl ShortcutBinding {
    fn display(self) -> &'static str {
        #[cfg(target_os = "macos")]
        {
            match self {
                Self::Win => "Control + Command + Space",
                Self::AltSpace => "Control + Option + Space",
                Self::ShiftSpace => "Control + Shift + Space",
                Self::WinSpace => "Control + Command + Space",
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            match self {
                Self::Win => "Ctrl + Win",
                Self::AltSpace => "Ctrl + Alt + Space",
                Self::ShiftSpace => "Ctrl + Shift + Space",
                Self::WinSpace => "Ctrl + Win + Space",
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    binding: ShortcutBinding,
    display: &'static str,
    enabled: bool,
    listener_status: &'static str,
    last_error: Option<String>,
}

#[derive(Clone, Serialize)]
struct RecordShortcutPayload {
    shortcut: &'static str,
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

#[cfg(target_os = "macos")]
pub fn handle_global_shortcut(
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    platform::handle_global_shortcut(shortcut, event);
}

#[cfg(not(target_os = "macos"))]
pub fn handle_global_shortcut(
    _shortcut: &tauri_plugin_global_shortcut::Shortcut,
    _event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
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
        VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SPACE,
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

    pub fn status() -> Result<ShortcutStatus, AppError> {
        let state = state()?;
        let binding = *state.binding.read().map_err(|_| {
            shortcut_error(
                "shortcut_state_unavailable",
                "shortcut state is unavailable",
            )
        })?;
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

        Ok(ShortcutStatus {
            binding,
            display: binding.display(),
            enabled: state.enabled.load(Ordering::Acquire),
            listener_status: listener_status_label(state.listener_status.load(Ordering::Acquire)),
            last_error,
        })
    }

    pub fn register(binding: ShortcutBinding) -> Result<ShortcutStatus, AppError> {
        probe_conflict(binding)?;
        let state = state()?;

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
        let Ok(binding) = state.binding.read().map(|binding| *binding) else {
            return;
        };
        let matches = binding_matches(binding, &pressed);
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

    fn binding_matches(binding: ShortcutBinding, pressed: &HashSet<u32>) -> bool {
        let ctrl = pressed_any(pressed, &[VK_LCONTROL, VK_RCONTROL]);
        let alt = pressed_any(pressed, &[VK_LMENU, VK_RMENU]);
        let shift = pressed_any(pressed, &[VK_LSHIFT, VK_RSHIFT]);
        let windows = pressed_any(pressed, &[VK_LWIN, VK_RWIN]);
        let space = pressed.contains(&key(VK_SPACE));

        match binding {
            ShortcutBinding::Win => ctrl && windows && !alt && !shift,
            ShortcutBinding::AltSpace => ctrl && alt && space && !shift && !windows,
            ShortcutBinding::ShiftSpace => ctrl && shift && space && !alt && !windows,
            ShortcutBinding::WinSpace => ctrl && windows && space && !alt && !shift,
        }
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
                .map(|binding| *binding)
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

    fn probe_conflict(binding: ShortcutBinding) -> Result<(), AppError> {
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

    fn registration_probe(binding: ShortcutBinding) -> Option<(HOT_KEY_MODIFIERS, u32)> {
        let modifiers = match binding {
            ShortcutBinding::Win => return None,
            ShortcutBinding::AltSpace => MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
            ShortcutBinding::ShiftSpace => MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
            ShortcutBinding::WinSpace => MOD_CONTROL | MOD_WIN | MOD_NOREPEAT,
        };
        Some((modifiers, key(VK_SPACE)))
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
            assert!(binding_matches(ShortcutBinding::Win, &pressed));
        }

        #[test]
        fn extra_modifier_does_not_trigger_binding() {
            let pressed = HashSet::from([key(VK_LCONTROL), key(VK_LWIN), key(VK_LSHIFT)]);
            assert!(!binding_matches(ShortcutBinding::Win, &pressed));
        }

        #[test]
        fn configurable_binding_requires_its_terminal_key() {
            let without_space = HashSet::from([key(VK_LCONTROL), key(VK_LMENU)]);
            let with_space = HashSet::from([key(VK_LCONTROL), key(VK_LMENU), key(VK_SPACE)]);

            assert!(!binding_matches(ShortcutBinding::AltSpace, &without_space));
            assert!(binding_matches(ShortcutBinding::AltSpace, &with_space));
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
            "global shortcuts are only implemented for Windows",
            false,
        )
    }
}
