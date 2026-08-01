#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{
    App, AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::error::{AppError, CommandResult};

const OVERLAY_LABEL: &str = "overlay";
const OVERLAY_WIDTH: f64 = 480.0;
const OVERLAY_HEIGHT: f64 = 132.0;
const OVERLAY_MARGIN: i32 = 20;
#[cfg(target_os = "macos")]
static OVERLAY_PANEL: AtomicUsize = AtomicUsize::new(0);

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
    let target = foreground_display(window).unwrap_or_else(|| {
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        monitor.as_ref().map_or(
            TargetDisplay {
                work_area: WorkArea {
                    left: 0,
                    top: 0,
                    right: 1920,
                    bottom: 1080,
                },
                scale_factor: 1.0,
            },
            target_display,
        )
    });
    apply_target_display(window, target, position)?;

    if let Some(actual_target) = window
        .current_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(target_display)
        .filter(|actual| actual.work_area == target.work_area)
    {
        if (actual_target.scale_factor - target.scale_factor).abs() > 0.01 {
            apply_target_display(window, actual_target, position)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Debug, Clone, Copy)]
struct TargetDisplay {
    work_area: WorkArea,
    scale_factor: f64,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rectangle {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn target_display(monitor: &Monitor) -> TargetDisplay {
    let area = monitor.work_area();
    TargetDisplay {
        work_area: WorkArea {
            left: area.position.x,
            top: area.position.y,
            right: area.position.x + area.size.width as i32,
            bottom: area.position.y + area.size.height as i32,
        },
        scale_factor: valid_scale_factor(monitor.scale_factor()),
    }
}

fn apply_target_display<R: Runtime>(
    window: &WebviewWindow<R>,
    target: TargetDisplay,
    position: OverlayPosition,
) -> Result<(), String> {
    let (width, height, margin) = scaled_overlay_metrics(target.scale_factor);
    let (x, y) = calculate_position(target.work_area, width, height, margin, position);
    let scale_factor = valid_scale_factor(target.scale_factor);

    window
        .set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(
            f64::from(x) / scale_factor,
            f64::from(y) / scale_factor,
        ))
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    sync_overlay_panel_frame(window)?;
    Ok(())
}

fn scaled_overlay_metrics(scale_factor: f64) -> (i32, i32, i32) {
    let scale_factor = valid_scale_factor(scale_factor);
    (
        (OVERLAY_WIDTH * scale_factor).round().max(1.0) as i32,
        (OVERLAY_HEIGHT * scale_factor).round().max(1.0) as i32,
        (f64::from(OVERLAY_MARGIN) * scale_factor).round() as i32,
    )
}

fn valid_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
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
fn foreground_display<R: Runtime>(window: &WebviewWindow<R>) -> Option<TargetDisplay> {
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
            .then_some(TargetDisplay {
                work_area: WorkArea {
                    left: info.rcWork.left,
                    top: info.rcWork.top,
                    right: info.rcWork.right,
                    bottom: info.rcWork.bottom,
                },
                scale_factor: window.scale_factor().unwrap_or(1.0),
            })
    }
}

#[cfg(target_os = "macos")]
fn foreground_display<R: Runtime>(window: &WebviewWindow<R>) -> Option<TargetDisplay> {
    use std::ffi::c_void;
    use std::ptr;

    use core_foundation::array::CFArrayGetValueAtIndex;
    use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
    use core_foundation::dictionary::{
        CFDictionary, CFDictionaryGetTypeID, CFDictionaryGetValueIfPresent, CFDictionaryRef,
    };
    use core_foundation::number::{CFNumber, CFNumberGetTypeID, CFNumberRef};
    use core_foundation::string::CFStringRef;
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowOwnerPID,
    };
    use objc2_app_kit::NSWorkspace;

    fn dictionary_value(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<CFTypeRef> {
        let mut value: *const c_void = ptr::null();
        let found = unsafe {
            CFDictionaryGetValueIfPresent(
                dictionary,
                key as *const c_void,
                &mut value as *mut *const c_void,
            )
        };
        (found != 0 && !value.is_null()).then_some(value as CFTypeRef)
    }

    fn dictionary_i32(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<i32> {
        let value = dictionary_value(dictionary, key)?;
        if unsafe { CFGetTypeID(value) } != unsafe { CFNumberGetTypeID() } {
            return None;
        }
        let number = unsafe { CFNumber::wrap_under_get_rule(value as CFNumberRef) };
        number.to_i32()
    }

    let process_id = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let window_list = copy_window_info(options, kCGNullWindowID)?;
    let mut foreground_bounds = None;

    for index in 0..window_list.len() {
        let raw_value = unsafe {
            CFArrayGetValueAtIndex(window_list.as_concrete_TypeRef(), index) as CFTypeRef
        };
        if raw_value.is_null()
            || unsafe { CFGetTypeID(raw_value) } != unsafe { CFDictionaryGetTypeID() }
        {
            continue;
        }
        let dictionary_ref = raw_value as CFDictionaryRef;
        let owner_pid = dictionary_i32(dictionary_ref, unsafe { kCGWindowOwnerPID });
        let layer = dictionary_i32(dictionary_ref, unsafe { kCGWindowLayer });
        if owner_pid != Some(process_id) || layer != Some(0) {
            continue;
        }

        let Some(bounds_value) = dictionary_value(dictionary_ref, unsafe { kCGWindowBounds })
        else {
            continue;
        };
        if unsafe { CFGetTypeID(bounds_value) } != unsafe { CFDictionaryGetTypeID() } {
            continue;
        }
        let bounds_dictionary =
            unsafe { CFDictionary::wrap_under_get_rule(bounds_value as CFDictionaryRef) };
        let Some(bounds) = CGRect::from_dict_representation(&bounds_dictionary) else {
            continue;
        };
        if bounds.size.width > 0.0 && bounds.size.height > 0.0 {
            foreground_bounds = Some(bounds);
            break;
        }
    }

    let bounds = foreground_bounds?;
    let monitors = window.available_monitors().ok()?;
    monitors
        .into_iter()
        .map(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            let scale_factor = valid_scale_factor(monitor.scale_factor());
            let area = overlap_area(
                Rectangle {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                },
                physical_to_logical(
                    Rectangle {
                        x: f64::from(origin.x),
                        y: f64::from(origin.y),
                        width: f64::from(size.width),
                        height: f64::from(size.height),
                    },
                    scale_factor,
                ),
            );
            (monitor, area)
        })
        .max_by_key(|(_, area)| *area)
        .filter(|(_, area)| *area > 0)
        .map(|(monitor, _)| target_display(&monitor))
}

#[cfg(any(target_os = "macos", test))]
fn physical_to_logical(rectangle: Rectangle, scale_factor: f64) -> Rectangle {
    let scale_factor = valid_scale_factor(scale_factor);
    Rectangle {
        x: rectangle.x / scale_factor,
        y: rectangle.y / scale_factor,
        width: rectangle.width / scale_factor,
        height: rectangle.height / scale_factor,
    }
}

#[cfg(any(target_os = "macos", test))]
fn overlap_area(first: Rectangle, second: Rectangle) -> u64 {
    let width = (first.x + first.width).min(second.x + second.width) - first.x.max(second.x);
    let height = (first.y + first.height).min(second.y + second.height) - first.y.max(second.y);
    if width <= 0.0 || height <= 0.0 {
        return 0;
    }
    (width * height).round() as u64
}

#[cfg(not(any(windows, target_os = "macos")))]
fn foreground_display<R: Runtime>(window: &WebviewWindow<R>) -> Option<TargetDisplay> {
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
    Some(target_display(&monitor))
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
    use objc2::rc::Retained;
    use objc2::MainThreadOnly;
    use objc2_app_kit::{
        NSBackingStoreType, NSColor, NSPanel, NSScreenSaverWindowLevel, NSWindow,
        NSWindowCollectionBehavior, NSWindowOrderingMode, NSWindowStyleMask,
    };

    let Ok(native_window) = window.ns_window() else {
        return;
    };
    let native_window = native_window as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        let native_window = &*(native_window as *mut NSWindow);
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
            NSPanel::alloc(mtm),
            native_window.frame(),
            NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            NSBackingStoreType::Buffered,
            false,
        );
        panel.setFloatingPanel(true);
        panel.setBecomesKeyOnlyIfNeeded(true);
        panel.setLevel(NSScreenSaverWindowLevel);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllApplications
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel.setHidesOnDeactivate(false);
        panel.setOpaque(false);
        panel.setBackgroundColor(Some(&NSColor::clearColor()));
        panel.setHasShadow(false);
        panel.setReleasedWhenClosed(false);
        panel.setIgnoresMouseEvents(true);

        // Keep Tauri's NSWindow and WKWebView hierarchy intact. Tao assumes the
        // NSWindow always owns its content view and crashes if it is moved to a
        // replacement panel. A borderless NSPanel instead acts as a Space-aware
        // carrier; AppKit moves its child window with it into fullscreen Spaces.
        native_window.setLevel(NSScreenSaverWindowLevel);
        native_window.setOpaque(false);
        native_window.setBackgroundColor(Some(&NSColor::clearColor()));
        native_window.setHasShadow(false);
        native_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllApplications
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel.addChildWindow_ordered(native_window, NSWindowOrderingMode::Above);
        panel.orderOut(None);
        let panel = Retained::into_raw(panel) as usize;
        OVERLAY_PANEL.store(panel, Ordering::Release);
        #[cfg(debug_assertions)]
        eprintln!("overlay: native NSPanel initialized");
    });
}

#[cfg(target_os = "macos")]
fn sync_overlay_panel_frame<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowOrderingMode};

    let panel = OVERLAY_PANEL.load(Ordering::Acquire);
    if panel == 0 {
        return Ok(());
    }
    let native_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    window
        .run_on_main_thread(move || unsafe {
            let native_window = &*(native_window as *mut NSWindow);
            let panel = &*(panel as *mut NSPanel);
            let frame = native_window.frame();

            // Moving a parent window also moves its children. Detach briefly so
            // synchronizing the invisible carrier cannot offset the real overlay.
            panel.removeChildWindow(native_window);
            panel.setFrame_display(frame, false);
            panel.addChildWindow_ordered(native_window, NSWindowOrderingMode::Above);
        })
        .map_err(|error| error.to_string())
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
    use objc2::ClassType;
    use objc2_app_kit::{
        NSPanel, NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior,
        NSWindowOrderingMode,
    };

    let panel = OVERLAY_PANEL.load(Ordering::Acquire);
    if panel == 0 {
        return Err("原生悬浮面板尚未初始化".to_string());
    }
    let native_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    window
        .run_on_main_thread(move || unsafe {
            let panel = &*(panel as *mut NSPanel);
            let native_window = &*(native_window as *mut NSWindow);
            panel.setLevel(NSScreenSaverWindowLevel);
            panel.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllApplications
                    | NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            native_window.setLevel(NSScreenSaverWindowLevel);
            native_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllApplications
                    | NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            if native_window.parentWindow().as_deref() != Some(panel.as_super()) {
                panel.addChildWindow_ordered(native_window, NSWindowOrderingMode::Above);
            }
            panel.orderFrontRegardless();
            native_window.orderFrontRegardless();
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_without_activation<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn hide_native_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use objc2_app_kit::{NSPanel, NSWindow};

    let panel = OVERLAY_PANEL.load(Ordering::Acquire);
    if panel == 0 {
        return Ok(());
    }
    let native_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    window
        .run_on_main_thread(move || unsafe {
            (&*(native_window as *mut NSWindow)).orderOut(None);
            (&*(panel as *mut NSPanel)).orderOut(None);
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn hide_native_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        calculate_position, overlap_area, physical_to_logical, scaled_overlay_metrics,
        OverlayPosition, Rectangle, WorkArea,
    };

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

    #[test]
    fn calculates_window_overlap_for_monitor_selection() {
        assert_eq!(
            overlap_area(
                Rectangle {
                    x: 0.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                },
                Rectangle {
                    x: 700.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                }
            ),
            60_000
        );
        assert_eq!(
            overlap_area(
                Rectangle {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
                Rectangle {
                    x: 200.0,
                    y: 200.0,
                    width: 100.0,
                    height: 100.0,
                }
            ),
            0
        );
    }

    #[test]
    fn scales_overlay_dimensions_for_target_display() {
        assert_eq!(scaled_overlay_metrics(1.0), (480, 132, 20));
        assert_eq!(scaled_overlay_metrics(2.0), (960, 264, 40));
        assert_eq!(scaled_overlay_metrics(f64::NAN), (480, 132, 20));
    }

    #[test]
    fn converts_monitor_bounds_to_quartz_logical_coordinates() {
        assert_eq!(
            physical_to_logical(
                Rectangle {
                    x: 2880.0,
                    y: 0.0,
                    width: 2880.0,
                    height: 1800.0,
                },
                2.0,
            ),
            Rectangle {
                x: 1440.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            }
        );
    }
}
