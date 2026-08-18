use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime, State,
};

use crate::error::{AppError, CommandResult};

const MODE_ASR_ONLY: &str = "asr_only";
const MODE_ASR_LLM: &str = "asr_llm";

pub struct TrayMenuState<R: Runtime> {
    open: MenuItem<R>,
    pages: Submenu<R>,
    page_record: MenuItem<R>,
    page_history: MenuItem<R>,
    page_connection: MenuItem<R>,
    page_settings: MenuItem<R>,
    modes: Submenu<R>,
    asr_only: CheckMenuItem<R>,
    asr_llm: CheckMenuItem<R>,
    quit: MenuItem<R>,
}

impl<R: Runtime> TrayMenuState<R> {
    fn set_mode(&self, mode: &str) -> tauri::Result<()> {
        self.asr_only.set_checked(mode == MODE_ASR_ONLY)?;
        self.asr_llm.set_checked(mode == MODE_ASR_LLM)?;
        Ok(())
    }

    fn configure(&self, locale: &str, diagnostics_enabled: bool) -> tauri::Result<()> {
        let labels = TrayLabels::for_locale(locale);
        self.open.set_text(labels.open)?;
        self.pages.set_text(labels.pages)?;
        self.page_record.set_text(labels.record)?;
        self.page_history.set_text(labels.history)?;
        self.page_connection.set_text(labels.diagnostics)?;
        self.page_connection.set_enabled(diagnostics_enabled)?;
        self.page_settings.set_text(labels.settings)?;
        self.modes.set_text(labels.modes)?;
        self.asr_only.set_text(labels.asr_only)?;
        self.asr_llm.set_text(labels.asr_llm)?;
        self.quit.set_text(labels.quit)?;
        Ok(())
    }
}

struct TrayLabels {
    open: &'static str,
    pages: &'static str,
    record: &'static str,
    history: &'static str,
    diagnostics: &'static str,
    settings: &'static str,
    modes: &'static str,
    asr_only: &'static str,
    asr_llm: &'static str,
    quit: &'static str,
}

impl TrayLabels {
    fn for_locale(locale: &str) -> Self {
        if locale == "en-US" {
            Self {
                open: "Open Main Window",
                pages: "Open Page",
                record: "Record",
                history: "History",
                diagnostics: "Diagnostics",
                settings: "Settings",
                modes: "Interaction Mode",
                asr_only: "Transcribe",
                asr_llm: "Polish",
                quit: "Quit MindSurf Voice AI",
            }
        } else {
            Self {
                open: "打开主窗口",
                pages: "打开页面",
                record: "录音",
                history: "历史",
                diagnostics: "诊断",
                settings: "设置",
                modes: "交互模式",
                asr_only: "识别",
                asr_llm: "润色",
                quit: "退出 MindSurf Voice AI",
            }
        }
    }
}

pub fn initialize(app: &mut App) -> tauri::Result<()> {
    let handle = app.handle();
    let open = MenuItem::with_id(handle, "open", "打开主窗口", true, None::<&str>)?;
    let page_record = MenuItem::with_id(handle, "page_record", "录音", true, None::<&str>)?;
    let page_history = MenuItem::with_id(handle, "page_history", "历史", true, None::<&str>)?;
    let page_connection =
        MenuItem::with_id(handle, "page_connection", "诊断", false, None::<&str>)?;
    let page_settings = MenuItem::with_id(handle, "page_settings", "设置", true, None::<&str>)?;
    let pages = Submenu::with_items(
        handle,
        "打开页面",
        true,
        &[
            &page_record,
            &page_history,
            &page_connection,
            &page_settings,
        ],
    )?;

    let asr_only = CheckMenuItemBuilder::with_id("mode_asr_only", "识别")
        .checked(true)
        .build(handle)?;
    let asr_llm = CheckMenuItemBuilder::with_id("mode_asr_llm", "润色")
        .checked(false)
        .build(handle)?;
    let modes = Submenu::with_items(handle, "交互模式", true, &[&asr_only, &asr_llm])?;

    let separator = PredefinedMenuItem::separator(handle)?;
    let quit = MenuItem::with_id(handle, "quit", "退出 MindSurf Voice AI", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&open, &pages, &modes, &separator, &quit])?;

    app.manage(TrayMenuState {
        open,
        pages,
        page_record,
        page_history,
        page_connection,
        page_settings,
        modes,
        asr_only,
        asr_llm,
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
        "page_history" => navigate(app, "history"),
        "page_connection" => navigate(app, "connection"),
        "page_settings" => navigate(app, "settings"),
        "mode_asr_only" => request_mode(app, MODE_ASR_ONLY),
        "mode_asr_llm" => request_mode(app, MODE_ASR_LLM),
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
    if !matches!(mode.as_str(), MODE_ASR_ONLY | MODE_ASR_LLM) {
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

pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
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
        assert_eq!(chinese.history, "历史");
        assert_eq!(chinese.diagnostics, "诊断");
        assert_eq!(chinese.settings, "设置");

        let english = TrayLabels::for_locale("en-US");
        assert_eq!(english.record, "Record");
        assert_eq!(english.history, "History");
        assert_eq!(english.diagnostics, "Diagnostics");
        assert_eq!(english.settings, "Settings");
    }
}
