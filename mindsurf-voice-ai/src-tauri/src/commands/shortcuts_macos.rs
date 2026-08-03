use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
use objc2_web_kit::{WKInactiveSchedulingPolicy, WKWebView};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use super::{AppError, RecordShortcutPayload, ShortcutBinding, ShortcutStatus};

const LISTENER_STARTING: u8 = 0;
const LISTENER_RUNNING: u8 = 1;
const LISTENER_ERROR: u8 = 2;
static STATE: OnceLock<ShortcutStateData> = OnceLock::new();

struct ShortcutStateData {
    app: tauri::AppHandle,
    binding: RwLock<ShortcutBinding>,
    enabled: AtomicBool,
    active: AtomicBool,
    registered: Mutex<Option<Shortcut>>,
    listener_status: AtomicU8,
    last_error: Mutex<Option<String>>,
    event_sender: Sender<ShortcutNotification>,
}

enum ShortcutNotification {
    Pressed(ShortcutBinding, u64),
    Released(ShortcutBinding, u64),
}

pub fn initialize(app: tauri::AppHandle) {
    keep_process_responsive_in_background();
    disable_main_webview_inactive_suspension(&app);
    let (event_sender, event_receiver) = mpsc::channel();
    if STATE
        .set(ShortcutStateData {
            app: app.clone(),
            binding: RwLock::new(ShortcutBinding::default()),
            enabled: AtomicBool::new(false),
            active: AtomicBool::new(false),
            registered: Mutex::new(None),
            listener_status: AtomicU8::new(LISTENER_STARTING),
            last_error: Mutex::new(None),
            event_sender,
        })
        .is_err()
    {
        return;
    }

    thread::spawn(move || emit_shortcut_events(app, event_receiver));
    #[cfg(debug_assertions)]
    eprintln!("shortcut listener: initialized");
}

pub fn status() -> Result<ShortcutStatus, AppError> {
    let state = state()?;
    let binding = state.binding.read().map_err(|_| state_error())?.clone();
    let last_error = state.last_error.lock().map_err(|_| state_error())?.clone();

    let display = binding.display();
    Ok(ShortcutStatus {
        binding,
        display,
        enabled: state.enabled.load(Ordering::Acquire),
        listener_status: listener_status_label(state.listener_status.load(Ordering::Acquire)),
        last_error,
        environment: "macos",
        supports_modifier_only: false,
    })
}

pub fn register(binding: ShortcutBinding) -> Result<ShortcutStatus, AppError> {
    let state = state()?;
    let shortcut = shortcut_for_binding(&binding)?;
    let mut registered = state.registered.lock().map_err(|_| state_error())?;

    if registered.as_ref() != Some(&shortcut) {
        let previous = *registered;
        if let Some(previous) = previous {
            state
                .app
                .global_shortcut()
                .unregister(previous)
                .map_err(|error| shortcut_error("shortcut_listener_unavailable", error))?;
        }

        if let Err(error) = state.app.global_shortcut().register(shortcut) {
            if let Some(previous) = previous {
                let _ = state.app.global_shortcut().register(previous);
            }
            set_listener_failure(format!("macOS 全局快捷键注册失败：{error}"));
            return Err(shortcut_error("shortcut_conflict", error));
        }
        *registered = Some(shortcut);
    }
    drop(registered);

    release_if_active(state);
    *state.binding.write().map_err(|_| state_error())? = binding.clone();
    state.enabled.store(true, Ordering::Release);
    state
        .listener_status
        .store(LISTENER_RUNNING, Ordering::Release);
    if let Ok(mut error) = state.last_error.lock() {
        *error = None;
    }
    #[cfg(debug_assertions)]
    eprintln!("shortcut listener: registered {}", binding.display());
    status()
}

pub fn unregister() -> Result<ShortcutStatus, AppError> {
    let state = state()?;
    release_if_active(state);
    if let Some(shortcut) = state.registered.lock().map_err(|_| state_error())?.take() {
        state
            .app
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| shortcut_error("shortcut_listener_unavailable", error))?;
    }
    state.enabled.store(false, Ordering::Release);
    state
        .listener_status
        .store(LISTENER_RUNNING, Ordering::Release);
    status()
}

pub fn handle_global_shortcut(shortcut: &Shortcut, event: ShortcutEvent) {
    let Some(state) = STATE.get() else {
        return;
    };
    if !state.enabled.load(Ordering::Acquire) {
        return;
    }
    let Ok(registered) = state.registered.lock() else {
        return;
    };
    if registered.as_ref() != Some(shortcut) {
        return;
    }
    drop(registered);

    let Ok(binding) = state.binding.read().map(|binding| binding.clone()) else {
        return;
    };
    match event.state {
        ShortcutState::Pressed if !state.active.swap(true, Ordering::AcqRel) => {
            #[cfg(debug_assertions)]
            eprintln!("shortcut listener: pressed {}", binding.display());
            let _ = state
                .event_sender
                .send(ShortcutNotification::Pressed(binding, timestamp_ms()));
        }
        ShortcutState::Released if state.active.swap(false, Ordering::AcqRel) => {
            #[cfg(debug_assertions)]
            eprintln!("shortcut listener: released {}", binding.display());
            let _ = state
                .event_sender
                .send(ShortcutNotification::Released(binding, timestamp_ms()));
        }
        _ => {}
    }
}

fn shortcut_for_binding(binding: &ShortcutBinding) -> Result<Shortcut, AppError> {
    let parsed = binding.parse()?;
    if parsed.code.is_none() {
        return Err(shortcut_error(
            "shortcut_modifier_only_unsupported",
            "modifier-only shortcuts are not supported on macOS",
        ));
    }
    binding
        .canonical_value()
        .parse::<Shortcut>()
        .map_err(|error| shortcut_error("shortcut_invalid", error))
}

fn release_if_active(state: &ShortcutStateData) {
    if state.active.swap(false, Ordering::AcqRel) {
        let binding = state
            .binding
            .read()
            .map(|binding| binding.clone())
            .unwrap_or_default();
        let _ = state
            .event_sender
            .send(ShortcutNotification::Released(binding, timestamp_ms()));
    }
}

fn emit_shortcut_events(app: tauri::AppHandle, receiver: Receiver<ShortcutNotification>) {
    while let Ok(notification) = receiver.recv() {
        let Some(main_window) = app.get_webview_window("main") else {
            #[cfg(debug_assertions)]
            eprintln!("shortcut event: main webview unavailable");
            continue;
        };

        // WKWebView may throttle a background window. A no-op evaluation wakes its
        // JavaScript event loop before the shortcut event is dispatched to it.
        let wake_result = main_window.eval("void 0");
        match notification {
            ShortcutNotification::Pressed(binding, timestamp_ms) => {
                let result = main_window.emit(
                    "shortcut://record-pressed",
                    RecordShortcutPayload {
                        shortcut: binding.display(),
                        timestamp_ms,
                    },
                );
                #[cfg(debug_assertions)]
                eprintln!(
                    "shortcut event: emitted pressed to main (wake={wake_result:?}, emit={result:?})"
                );
            }
            ShortcutNotification::Released(binding, timestamp_ms) => {
                let result = main_window.emit(
                    "shortcut://record-released",
                    RecordShortcutPayload {
                        shortcut: binding.display(),
                        timestamp_ms,
                    },
                );
                #[cfg(debug_assertions)]
                eprintln!(
                    "shortcut event: emitted released to main (wake={wake_result:?}, emit={result:?})"
                );
            }
        }
    }
}

fn keep_process_responsive_in_background() {
    let reason = NSString::from_str("MindSurf global push-to-talk shortcut");
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &reason,
    );

    // The shortcut is process-wide and remains registered for the app lifetime,
    // so the matching NSProcessInfo activity intentionally has the same lifetime.
    std::mem::forget(activity);
    #[cfg(debug_assertions)]
    eprintln!("shortcut listener: background activity started");
}

fn disable_main_webview_inactive_suspension(app: &tauri::AppHandle) {
    let Some(main_window) = app.get_webview_window("main") else {
        #[cfg(debug_assertions)]
        eprintln!("shortcut listener: cannot configure missing main webview");
        return;
    };

    let result = main_window.with_webview(|webview| unsafe {
        let view: &WKWebView = &*webview.inner().cast();
        view.configuration()
            .preferences()
            .setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None);
        #[cfg(debug_assertions)]
        eprintln!("shortcut listener: disabled inactive webview suspension");
    });
    #[cfg(debug_assertions)]
    if let Err(error) = result {
        eprintln!("shortcut listener: webview configuration failed: {error}");
    }
}

fn set_listener_failure(message: String) {
    let Some(state) = STATE.get() else {
        return;
    };
    release_if_active(state);
    state
        .listener_status
        .store(LISTENER_ERROR, Ordering::Release);
    if let Ok(mut error) = state.last_error.lock() {
        *error = Some(message);
    }
}

fn state() -> Result<&'static ShortcutStateData, AppError> {
    STATE.get().ok_or_else(|| {
        shortcut_error(
            "shortcut_listener_unavailable",
            "global shortcut listener is not initialized",
        )
    })
}

fn state_error() -> AppError {
    shortcut_error(
        "shortcut_state_unavailable",
        "shortcut state is unavailable",
    )
}

fn listener_status_label(status: u8) -> &'static str {
    match status {
        LISTENER_RUNNING => "running",
        LISTENER_ERROR => "error",
        _ => "starting",
    }
}

fn shortcut_error(code: &str, message: impl ToString) -> AppError {
    AppError::new(code, message.to_string(), true)
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{shortcut_for_binding, ShortcutBinding};

    #[test]
    fn rejects_modifier_only_binding() {
        assert!(shortcut_for_binding(&ShortcutBinding::new("control+super")).is_err());
    }

    #[test]
    fn configurable_system_hotkeys_are_distinct() {
        assert_ne!(
            shortcut_for_binding(&ShortcutBinding::new("control+alt+Space")).unwrap(),
            shortcut_for_binding(&ShortcutBinding::new("shift+control+Space")).unwrap()
        );
    }
}
