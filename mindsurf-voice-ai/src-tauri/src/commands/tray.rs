use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime, State,
};

use crate::error::{AppError, CommandResult};

const MODE_DICTATION: &str = "dictation";
const MODE_ASSISTANT: &str = "assistant";
const MODE_MIXED: &str = "mixed";

pub struct TrayMenuState<R: Runtime> {
    dictation: CheckMenuItem<R>,
    assistant: CheckMenuItem<R>,
    mixed: CheckMenuItem<R>,
}

impl<R: Runtime> TrayMenuState<R> {
    fn set_mode(&self, mode: &str) -> tauri::Result<()> {
        self.dictation.set_checked(mode == MODE_DICTATION)?;
        self.assistant.set_checked(mode == MODE_ASSISTANT)?;
        self.mixed.set_checked(mode == MODE_MIXED)?;
        Ok(())
    }
}

pub fn initialize(app: &mut App) -> tauri::Result<()> {
    let handle = app.handle();
    let open = MenuItem::with_id(handle, "open", "打开主窗口", true, None::<&str>)?;
    let page_record = MenuItem::with_id(handle, "page_record", "录音", true, None::<&str>)?;
    let page_connection = MenuItem::with_id(handle, "page_connection", "连接", true, None::<&str>)?;
    let page_settings = MenuItem::with_id(handle, "page_settings", "设置", true, None::<&str>)?;
    let pages = Submenu::with_items(
        handle,
        "打开页面",
        true,
        &[&page_record, &page_connection, &page_settings],
    )?;

    let dictation = CheckMenuItemBuilder::with_id("mode_dictation", "听写")
        .checked(true)
        .build(handle)?;
    let assistant = CheckMenuItemBuilder::with_id("mode_assistant", "助手")
        .checked(false)
        .build(handle)?;
    let mixed = CheckMenuItemBuilder::with_id("mode_mixed", "混合")
        .checked(false)
        .build(handle)?;
    let modes = Submenu::with_items(handle, "交互模式", true, &[&dictation, &assistant, &mixed])?;

    let separator = PredefinedMenuItem::separator(handle)?;
    let quit = MenuItem::with_id(handle, "quit", "退出 MindSurf Voice AI", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&open, &pages, &modes, &separator, &quit])?;

    app.manage(TrayMenuState {
        dictation,
        assistant,
        mixed,
    });

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("MindSurf Voice AI")
        .menu(&menu)
        .show_menu_on_left_click(false);
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon_as_template(true);
    }

    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            show_main_window(tray.app_handle());
        }
    })
    .on_menu_event(|app, event| match event.id().as_ref() {
        "open" => show_main_window(app),
        "page_record" => navigate(app, "record"),
        "page_connection" => navigate(app, "connection"),
        "page_settings" => navigate(app, "settings"),
        "mode_dictation" => request_mode(app, MODE_DICTATION),
        "mode_assistant" => request_mode(app, MODE_ASSISTANT),
        "mode_mixed" => request_mode(app, MODE_MIXED),
        "quit" => quit_application(app),
        _ => {}
    })
    .build(app)?;

    Ok(())
}

#[tauri::command]
pub fn set_tray_mode(
    mode: String,
    tray: State<'_, TrayMenuState<tauri::Wry>>,
) -> CommandResult<()> {
    if !matches!(mode.as_str(), MODE_DICTATION | MODE_ASSISTANT | MODE_MIXED) {
        return CommandResult::failure(AppError::new(
            "invalid_voice_mode",
            "tray mode is invalid",
            true,
        ));
    }

    match tray.set_mode(&mode) {
        Ok(()) => CommandResult::success(()),
        Err(_) => CommandResult::failure(AppError::new(
            "tray_update_failed",
            "failed to update tray mode",
            true,
        )),
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn navigate<R: Runtime>(app: &AppHandle<R>, page: &str) {
    show_main_window(app);
    let _ = app.emit_to("main", "tray://navigate", page);
}

fn request_mode<R: Runtime>(app: &AppHandle<R>, mode: &str) {
    let _ = app.emit_to("main", "tray://mode", mode);
}

fn quit_application<R: Runtime>(app: &AppHandle<R>) {
    // Explicitly tear down WebView2 windows before ending the event loop. This
    // avoids Chromium trying to unregister its window class while child
    // windows from another webview are still alive.
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.destroy();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
    app.exit(0);
}
