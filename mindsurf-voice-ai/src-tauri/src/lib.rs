mod commands;
mod error;
#[cfg(target_os = "macos")]
mod mac_instance;

use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::Emitter;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use tauri::Manager;

#[derive(Default)]
pub(crate) struct PendingAuthCallbacks(Mutex<Vec<String>>);

#[cfg(target_os = "macos")]
pub(crate) fn enqueue_auth_callbacks(app: &tauri::AppHandle, callbacks: Vec<String>) {
    if callbacks.is_empty() {
        return;
    }
    if let Ok(mut pending) = app.state::<PendingAuthCallbacks>().0.lock() {
        pending.extend(callbacks);
    }
    let _ = app.emit("auth://callback-received", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn take_pending_auth_callbacks(state: tauri::State<'_, PendingAuthCallbacks>) -> Vec<String> {
    let Ok(mut callbacks) = state.0.lock() else {
        return Vec::new();
    };
    std::mem::take(&mut *callbacks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .manage(PendingAuthCallbacks::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|_app, shortcut, event| {
                    commands::shortcuts::handle_global_shortcut(shortcut, event);
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            mac_instance::initialize(app.handle());
            let _ = commands::credentials::purge_obsolete_credentials(app.handle());
            let _ = commands::diagnostics::initialize(app.handle());
            commands::shortcuts::initialize(app.handle().clone());
            commands::overlay::initialize(app)?;
            commands::tray::initialize(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info::get_app_info,
            commands::credentials::get_refresh_token,
            commands::credentials::get_refresh_token_status,
            commands::credentials::save_refresh_token,
            commands::credentials::clear_refresh_token,
            commands::diagnostics::export_diagnostics,
            commands::diagnostics::clear_diagnostic_logs,
            commands::diagnostics::open_diagnostic_log_directory,
            commands::diagnostics::read_recent_log_entries,
            commands::diagnostics::write_log_entry,
            commands::permissions::get_system_permission_status,
            commands::permissions::open_permission_settings,
            commands::permissions::request_system_permission,
            commands::privacy::clear_local_application_data,
            commands::native_recorder::cancel_native_audio_recording,
            commands::native_recorder::native_audio_recording_level,
            commands::native_recorder::native_audio_recording_meter,
            commands::native_recorder::start_native_audio_recording,
            commands::native_recorder::stop_native_audio_recording,
            commands::shortcuts::get_record_shortcut_status,
            commands::shortcuts::register_record_shortcut,
            commands::shortcuts::report_shortcut_event_handled,
            commands::shortcuts::unregister_record_shortcut,
            commands::text_injection::prepare_text_injection_target,
            commands::text_injection::inject_text,
            commands::overlay::hide_overlay,
            commands::overlay::set_overlay_position,
            commands::overlay::show_overlay,
            commands::tray::configure_tray_menu,
            commands::tray::set_tray_mode,
            take_pending_auth_callbacks
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MindSurf Voice AI")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let callbacks = urls
                    .into_iter()
                    .map(|url| url.to_string())
                    .filter(|url| url.starts_with("mindsurf://auth/callback"))
                    .collect::<Vec<_>>();
                let broker = app.state::<mac_instance::MacInstanceBroker>();
                if broker.is_primary() {
                    enqueue_auth_callbacks(app, callbacks);
                } else {
                    broker.forward(&callbacks);
                    app.exit(0);
                }
            }
        });
}
