mod commands;
mod error;
use std::ffi::OsStr;
#[cfg(all(debug_assertions, any(target_os = "windows", target_os = "linux")))]
use tauri_plugin_deep_link::DeepLinkExt;

const AUTOSTART_ARGUMENT: &str = "--autostart";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first so secondary-instance deep links are forwarded
        // to the primary process before the secondary process exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            commands::tray::show_main_window(app);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(AUTOSTART_ARGUMENT)
                .build(),
        )
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
            let launched_by_autostart = is_autostart_launch(std::env::args_os());

            // `tauri dev` does not run an installer, so Windows and Linux do not
            // otherwise know which executable should handle the configured schemes.
            #[cfg(all(debug_assertions, any(target_os = "windows", target_os = "linux")))]
            app.deep_link().register_all()?;

            let _ = commands::credentials::purge_obsolete_credentials(app.handle());
            let _ = commands::diagnostics::initialize(app.handle());
            commands::shortcuts::initialize(app.handle().clone());
            commands::overlay::initialize(app)?;
            commands::tray::initialize(app)?;
            if launched_by_autostart {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            } else {
                commands::tray::show_main_window(app.handle());
            }
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
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MindSurf Voice AI")
        .run(|_, _| {});
}

fn is_autostart_launch<I, S>(arguments: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    arguments
        .into_iter()
        .any(|argument| argument.as_ref() == OsStr::new(AUTOSTART_ARGUMENT))
}

#[cfg(test)]
mod tests {
    use super::is_autostart_launch;

    #[test]
    fn detects_only_the_dedicated_autostart_argument() {
        assert!(is_autostart_launch(["mindsurf", "--autostart"]));
        assert!(!is_autostart_launch(["mindsurf", "--autostart=false"]));
        assert!(!is_autostart_launch(["mindsurf"]));
    }
}
