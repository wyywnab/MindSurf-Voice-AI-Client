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
    open: MenuItem<R>,
    pages: Submenu<R>,
    page_record: MenuItem<R>,
    page_connection: MenuItem<R>,
    page_permissions: MenuItem<R>,
    page_settings: MenuItem<R>,
    modes: Submenu<R>,
    dictation: CheckMenuItem<R>,
    assistant: CheckMenuItem<R>,
    mixed: CheckMenuItem<R>,
    quit: MenuItem<R>,
}

impl<R: Runtime> TrayMenuState<R> {
    fn set_mode(&self, mode: &str) -> tauri::Result<()> {
        self.dictation.set_checked(mode == MODE_DICTATION)?;
        self.assistant.set_checked(mode == MODE_ASSISTANT)?;
        self.mixed.set_checked(mode == MODE_MIXED)?;
        Ok(())
    }

    fn configure(&self, locale: &str, diagnostics_enabled: bool) -> tauri::Result<()> {
        let labels = TrayLabels::for_locale(locale);
        self.open.set_text(labels.open)?;
        self.pages.set_text(labels.pages)?;
        self.page_record.set_text(labels.record)?;
        self.page_connection.set_text(labels.diagnostics)?;
        self.page_connection.set_enabled(diagnostics_enabled)?;
        self.page_permissions.set_text(labels.permissions)?;
        self.page_settings.set_text(labels.settings)?;
        self.modes.set_text(labels.modes)?;
        self.dictation.set_text(labels.dictation)?;
        self.assistant.set_text(labels.assistant)?;
        self.mixed.set_text(labels.mixed)?;
        self.quit.set_text(labels.quit)?;
        Ok(())
    }
}

struct TrayLabels {
    open: &'static str,
    pages: &'static str,
    record: &'static str,
    diagnostics: &'static str,
    permissions: &'static str,
    settings: &'static str,
    modes: &'static str,
    dictation: &'static str,
    assistant: &'static str,
    mixed: &'static str,
    quit: &'static str,
}

impl TrayLabels {
    fn for_locale(locale: &str) -> Self {
        if locale == "en-US" {
            Self {
                open: "Open Main Window",
                pages: "Open Page",
                record: "Record",
                diagnostics: "Diagnostics",
                permissions: "Permissions",
                settings: "Settings",
                modes: "Interaction Mode",
                dictation: "Dictation",
                assistant: "Assistant",
                mixed: "Mixed",
                quit: "Quit MindSurf Voice AI",
            }
        } else {
            Self {
                open: "打开主窗口",
                pages: "打开页面",
                record: "录音",
                diagnostics: "诊断",
                permissions: "权限",
                settings: "设置",
                modes: "交互模式",
                dictation: "听写",
                assistant: "助手",
                mixed: "混合",
                quit: "退出 MindSurf Voice AI",
            }
        }
    }
}

pub fn initialize(app: &mut App) -> tauri::Result<()> {
    let handle = app.handle();
    let open = MenuItem::with_id(handle, "open", "打开主窗口", true, None::<&str>)?;
    let page_record = MenuItem::with_id(handle, "page_record", "录音", true, None::<&str>)?;
    let page_connection =
        MenuItem::with_id(handle, "page_connection", "诊断", false, None::<&str>)?;
    let page_permissions =
        MenuItem::with_id(handle, "page_permissions", "权限", true, None::<&str>)?;
    let page_settings = MenuItem::with_id(handle, "page_settings", "设置", true, None::<&str>)?;
    let pages = Submenu::with_items(
        handle,
        "打开页面",
        true,
        &[
            &page_record,
            &page_permissions,
            &page_connection,
            &page_settings,
        ],
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
        open,
        pages,
        page_record,
        page_connection,
        page_permissions,
        page_settings,
        modes,
        dictation,
        assistant,
        mixed,
        quit,
    });

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("MindSurf Voice AI")
        .menu(&menu)
        .show_menu_on_left_click(false);
    #[cfg(target_os = "macos")]
    let tray = tray.icon_as_template(true);

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
        "page_permissions" => navigate(app, "permissions"),
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
pub fn configure_tray_menu(
    locale: String,
    diagnostics_enabled: bool,
    tray: State<'_, TrayMenuState<tauri::Wry>>,
) -> CommandResult<()> {
    if !matches!(locale.as_str(), "zh-CN" | "en-US") {
        return CommandResult::failure(AppError::new(
            "invalid_locale",
            "tray locale is invalid",
            true,
        ));
    }
    match tray.configure(&locale, diagnostics_enabled) {
        Ok(()) => CommandResult::success(()),
        Err(_) => CommandResult::failure(AppError::new(
            "tray_update_failed",
            "failed to update tray menu",
            true,
        )),
    }
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

#[cfg(test)]
mod tests {
    use super::TrayLabels;

    #[test]
    fn localizes_every_tray_page() {
        let chinese = TrayLabels::for_locale("zh-CN");
        assert_eq!(chinese.record, "录音");
        assert_eq!(chinese.permissions, "权限");
        assert_eq!(chinese.diagnostics, "诊断");
        assert_eq!(chinese.settings, "设置");

        let english = TrayLabels::for_locale("en-US");
        assert_eq!(english.record, "Record");
        assert_eq!(english.permissions, "Permissions");
        assert_eq!(english.diagnostics, "Diagnostics");
        assert_eq!(english.settings, "Settings");
    }
}
