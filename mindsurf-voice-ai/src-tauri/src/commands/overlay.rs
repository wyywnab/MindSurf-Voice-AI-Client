use std::sync::Mutex;

use tauri::{
    App, AppHandle, Manager, PhysicalPosition, Runtime, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::{AppError, CommandResult};

const OVERLAY_LABEL: &str = "overlay";
const OVERLAY_WIDTH: f64 = 480.0;
const OVERLAY_HEIGHT: f64 = 132.0;
const OVERLAY_MARGIN: i32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlayPosition {
    Left,
    Center,
    Right,
}

impl OverlayPosition {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(Self::Left),
            "center" => Some(Self::Center),
            "right" => Some(Self::Right),
            _ => None,
        }
    }
}

pub struct OverlayWindowState {
    position: Mutex<OverlayPosition>,
}

impl Default for OverlayWindowState {
    fn default() -> Self {
        Self {
            position: Mutex::new(OverlayPosition::Center),
        }
    }
}

pub fn initialize(app: &mut App) -> tauri::Result<()> {
    app.manage(OverlayWindowState::default());

    let window = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html?view=overlay".into()),
    )
    .title("MindSurf Voice")
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focusable(false)
    .transparent(true)
    .visible(false)
    .build()?;

    configure_nonactivating_window(&window);
    let _ = reposition(&window, OverlayPosition::Center);
    Ok(())
}

#[tauri::command]
pub fn set_overlay_position(
    position: String,
    app: AppHandle,
    state: State<'_, OverlayWindowState>,
) -> CommandResult<()> {
    let Some(position) = OverlayPosition::parse(&position) else {
        return CommandResult::failure(AppError::new(
            "invalid_overlay_position",
            "悬浮窗位置无效",
            true,
        ));
    };

    let mut selected = match state.position.lock() {
        Ok(selected) => selected,
        Err(_) => {
            return CommandResult::failure(AppError::new(
                "overlay_state_unavailable",
                "悬浮窗状态不可用",
                true,
            ))
        }
    };
    *selected = position;
    drop(selected);

    match overlay_window(&app).and_then(|window| reposition(&window, position)) {
        Ok(()) => CommandResult::success(()),
        Err(error) => overlay_failure(error),
    }
}

#[tauri::command]
pub fn show_overlay(app: AppHandle, state: State<'_, OverlayWindowState>) -> CommandResult<()> {
    let position = match state.position.lock() {
        Ok(position) => *position,
        Err(_) => {
            return CommandResult::failure(AppError::new(
                "overlay_state_unavailable",
                "悬浮窗状态不可用",
                true,
            ))
        }
    };

    match overlay_window(&app).and_then(|window| {
        reposition(&window, position)?;
        show_without_activation(&window)
    }) {
        Ok(()) => CommandResult::success(()),
        Err(error) => overlay_failure(error),
    }
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> CommandResult<()> {
    match overlay_window(&app).and_then(|window| hide_native_window(&window)) {
        Ok(()) => CommandResult::success(()),
        Err(error) => overlay_failure(error),
    }
}

fn overlay_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "找不到悬浮窗".to_string())
}

fn overlay_failure(message: String) -> CommandResult<()> {
    CommandResult::failure(AppError::new("overlay_window_error", message, true))
}

fn reposition<R: Runtime>(
    window: &WebviewWindow<R>,
    position: OverlayPosition,
) -> Result<(), String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let margin = (f64::from(OVERLAY_MARGIN) * scale).round() as i32;
    let work_area = foreground_work_area(window).unwrap_or_else(|| {
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        monitor.map_or(
            WorkArea {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
            |monitor| {
                let origin = monitor.position();
                let monitor_size = monitor.size();
                WorkArea {
                    left: origin.x,
                    top: origin.y,
                    right: origin.x + monitor_size.width as i32,
                    bottom: origin.y + monitor_size.height as i32,
                }
            },
        )
    });
    let (x, y) = calculate_position(
        work_area,
        size.width as i32,
        size.height as i32,
        margin,
        position,
    );

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy)]
struct WorkArea {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

fn calculate_position(
    area: WorkArea,
    width: i32,
    height: i32,
    margin: i32,
    position: OverlayPosition,
) -> (i32, i32) {
    let available_width = area.right - area.left;
    let x = match position {
        OverlayPosition::Left => area.left + margin,
        OverlayPosition::Center => area.left + (available_width - width) / 2,
        OverlayPosition::Right => area.right - width - margin,
    }
    .clamp(area.left, (area.right - width).max(area.left));
    let y = (area.bottom - height - margin).clamp(area.top, (area.bottom - height).max(area.top));
    (x, y)
}

#[cfg(windows)]
fn foreground_work_area<R: Runtime>(_window: &WebviewWindow<R>) -> Option<WorkArea> {
    use std::mem::size_of;
    use windows::Win32::{
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::GetForegroundWindow,
    };

    unsafe {
        let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        GetMonitorInfoW(monitor, &mut info)
            .as_bool()
            .then_some(WorkArea {
                left: info.rcWork.left,
                top: info.rcWork.top,
                right: info.rcWork.right,
                bottom: info.rcWork.bottom,
            })
    }
}

#[cfg(not(windows))]
fn foreground_work_area<R: Runtime>(window: &WebviewWindow<R>) -> Option<WorkArea> {
    let cursor = window.cursor_position().ok()?;
    let monitors = window.available_monitors().ok()?;
    let monitor = monitors.into_iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        cursor.x >= f64::from(origin.x)
            && cursor.x < f64::from(origin.x) + f64::from(size.width)
            && cursor.y >= f64::from(origin.y)
            && cursor.y < f64::from(origin.y) + f64::from(size.height)
    })?;
    let area = monitor.work_area();
    Some(WorkArea {
        left: area.position.x,
        top: area.position.y,
        right: area.position.x + area.size.width as i32,
        bottom: area.position.y + area.size.height as i32,
    })
}

#[cfg(windows)]
fn configure_nonactivating_window<R: Runtime>(window: &WebviewWindow<R>) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let overlay_style = style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, overlay_style);
        }
    }
}

#[cfg(target_os = "macos")]
fn configure_nonactivating_window<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2_app_kit::{NSFloatingWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let Ok(native_window) = window.ns_window() else {
        return;
    };
    let native_window = native_window as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        let native_window = &*(native_window as *mut NSWindow);
        native_window.setLevel(NSFloatingWindowLevel);
        native_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        native_window.setHidesOnDeactivate(false);
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
fn configure_nonactivating_window<R: Runtime>(_window: &WebviewWindow<R>) {}

#[cfg(windows)]
fn show_without_activation<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

#[cfg(windows)]
fn hide_native_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_without_activation<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use objc2_app_kit::NSWindow;

    let native_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    window
        .run_on_main_thread(move || unsafe {
            (&*(native_window as *mut NSWindow)).orderFrontRegardless();
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_without_activation<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn hide_native_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{calculate_position, OverlayPosition, WorkArea};

    const AREA: WorkArea = WorkArea {
        left: 100,
        top: 50,
        right: 2020,
        bottom: 1090,
    };

    #[test]
    fn positions_overlay_across_bottom_work_area() {
        assert_eq!(
            calculate_position(AREA, 480, 132, 20, OverlayPosition::Left),
            (120, 938)
        );
        assert_eq!(
            calculate_position(AREA, 480, 132, 20, OverlayPosition::Center),
            (820, 938)
        );
        assert_eq!(
            calculate_position(AREA, 480, 132, 20, OverlayPosition::Right),
            (1520, 938)
        );
    }

    #[test]
    fn clamps_overlay_to_small_work_area() {
        let area = WorkArea {
            left: 10,
            top: 20,
            right: 310,
            bottom: 120,
        };
        assert_eq!(
            calculate_position(area, 480, 132, 20, OverlayPosition::Right),
            (10, 20)
        );
    }
}
