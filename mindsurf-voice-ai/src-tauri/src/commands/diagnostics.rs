use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::error::{AppError, CommandResult};

const CURRENT_LOG: &str = "current.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ROTATED_FILES: usize = 4;
const MAX_READ_ENTRIES: usize = 1_000;
static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    timestamp_ms: u64,
    level: String,
    module: String,
    event: String,
    message: String,
    request_id: Option<String>,
    fields: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport {
    path: String,
    log_files: usize,
}

pub fn initialize(app: &AppHandle) -> tauri::Result<()> {
    let directory = log_directory(app)?;
    fs::create_dir_all(&directory)?;
    cleanup_logs(&directory)?;
    Ok(())
}

#[tauri::command]
pub fn write_log_entry(
    window: WebviewWindow,
    app: AppHandle,
    mut entry: LogEntry,
) -> CommandResult<()> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    redact_log_entry(&mut entry);
    match append_log(&app, &entry) {
        Ok(()) => CommandResult::success(()),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn read_recent_log_entries(
    window: WebviewWindow,
    app: AppHandle,
    limit: usize,
    before_timestamp_ms: Option<u64>,
) -> CommandResult<Vec<LogEntry>> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match read_logs(&app, limit.clamp(1, MAX_READ_ENTRIES), before_timestamp_ms) {
        Ok(entries) => CommandResult::success(entries),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn export_diagnostics(
    window: WebviewWindow,
    app: AppHandle,
    mut summary: Value,
    mut timelines: Value,
) -> CommandResult<DiagnosticsExport> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    redact_value(&mut summary);
    redact_value(&mut timelines);
    match create_export(&app, &summary, &timelines) {
        Ok(result) => CommandResult::success(result),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn clear_diagnostic_logs(window: WebviewWindow, app: AppHandle) -> CommandResult<()> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match clear_logs(&app) {
        Ok(()) => CommandResult::success(()),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn open_diagnostic_log_directory(
    window: WebviewWindow,
    app: AppHandle,
) -> CommandResult<String> {
    if let Err(error) = super::access::require_main_window(&window) {
        return CommandResult::failure(error);
    }
    match open_log_directory(&app) {
        Ok(path) => CommandResult::success(path),
        Err(error) => CommandResult::failure(error),
    }
}

fn append_log(app: &AppHandle, entry: &LogEntry) -> Result<(), AppError> {
    let _guard = log_lock();
    let directory = log_directory(app).map_err(diagnostics_error)?;
    fs::create_dir_all(&directory).map_err(diagnostics_error)?;
    rotate_if_needed(&directory).map_err(diagnostics_error)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(CURRENT_LOG))
        .map_err(diagnostics_error)?;
    serde_json::to_writer(&mut file, entry).map_err(diagnostics_error)?;
    file.write_all(b"\n").map_err(diagnostics_error)
}

fn read_logs(
    app: &AppHandle,
    limit: usize,
    before_timestamp_ms: Option<u64>,
) -> Result<Vec<LogEntry>, AppError> {
    let _guard = log_lock();
    let directory = log_directory(app).map_err(diagnostics_error)?;
    let mut entries = Vec::new();
    for path in log_paths_newest_first(&directory) {
        let Ok(file) = File::open(path) else { continue };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(entry) = serde_json::from_str::<LogEntry>(&line) else {
                continue;
            };
            if before_timestamp_ms.is_none_or(|before| entry.timestamp_ms < before) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.timestamp_ms));
    entries.truncate(limit);
    Ok(entries)
}

fn create_export(
    app: &AppHandle,
    summary: &Value,
    timelines: &Value,
) -> Result<DiagnosticsExport, AppError> {
    let _guard = log_lock();
    let root = app.path().app_data_dir().map_err(diagnostics_error)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(diagnostics_error)?
        .as_millis();
    fs::create_dir_all(&root).map_err(diagnostics_error)?;
    let export = root.join(format!("diagnostic-{timestamp}.zip"));
    let app_info = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" }
    });
    let environment = serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
    });
    let source = log_directory(app).map_err(diagnostics_error)?;
    let paths = log_paths_newest_first(&source);
    let mut combined_logs = Vec::new();
    for path in &paths {
        combined_logs.extend(fs::read(path).map_err(diagnostics_error)?);
    }
    let entries = vec![
        ("app-info.json", json_bytes(&app_info)?),
        ("environment.json", json_bytes(&environment)?),
        ("settings-sanitized.json", json_bytes(summary)?),
        ("recent-requests.json", json_bytes(timelines)?),
        ("timelines.json", json_bytes(timelines)?),
        ("client.log", combined_logs),
        (
            "README.txt",
            "MindSurf Voice AI diagnostic bundle\nSensitive credentials, full transcripts, replies, and audio are excluded.\n"
                .as_bytes()
                .to_vec(),
        ),
    ];
    write_zip(&export, &entries)?;
    Ok(DiagnosticsExport {
        path: export.to_string_lossy().into_owned(),
        log_files: paths.len(),
    })
}

fn json_bytes(value: &Value) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec_pretty(value).map_err(diagnostics_error)
}

pub(crate) fn clear_logs(app: &AppHandle) -> Result<(), AppError> {
    let _guard = log_lock();
    let directory = log_directory(app).map_err(diagnostics_error)?;
    for path in log_paths_newest_first(&directory) {
        fs::remove_file(path).map_err(diagnostics_error)?;
    }
    Ok(())
}

fn open_log_directory(app: &AppHandle) -> Result<String, AppError> {
    let directory = log_directory(app).map_err(diagnostics_error)?;
    fs::create_dir_all(&directory).map_err(diagnostics_error)?;
    let status = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(&directory)
            .status()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&directory).status()
    } else {
        return Err(diagnostics_error(
            "opening the log directory is unsupported",
        ));
    }
    .map_err(diagnostics_error)?;
    if !status.success() {
        return Err(diagnostics_error("unable to open the log directory"));
    }
    Ok(directory.to_string_lossy().into_owned())
}

fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) -> Result<(), AppError> {
    let mut file = File::create(path).map_err(diagnostics_error)?;
    let mut central = Vec::new();
    let mut offset = 0u32;
    for (name, data) in entries {
        let name = name.as_bytes();
        let crc = crc32(data);
        write_u32(&mut file, 0x0403_4b50)?;
        write_u16(&mut file, 20)?;
        write_u16(&mut file, 0x0800)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, crc)?;
        write_u32(&mut file, data.len() as u32)?;
        write_u32(&mut file, data.len() as u32)?;
        write_u16(&mut file, name.len() as u16)?;
        write_u16(&mut file, 0)?;
        file.write_all(name).map_err(diagnostics_error)?;
        file.write_all(data).map_err(diagnostics_error)?;

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
        offset += 30 + name.len() as u32 + data.len() as u32;
    }
    let central_offset = offset;
    file.write_all(&central).map_err(diagnostics_error)?;
    write_u32(&mut file, 0x0605_4b50)?;
    write_u16(&mut file, 0)?;
    write_u16(&mut file, 0)?;
    write_u16(&mut file, entries.len() as u16)?;
    write_u16(&mut file, entries.len() as u16)?;
    write_u32(&mut file, central.len() as u32)?;
    write_u32(&mut file, central_offset)?;
    write_u16(&mut file, 0)
}

fn write_u16(writer: &mut File, value: u16) -> Result<(), AppError> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(diagnostics_error)
}

fn write_u32(writer: &mut File, value: u32) -> Result<(), AppError> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(diagnostics_error)
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn rotate_if_needed(directory: &Path) -> std::io::Result<()> {
    let current = directory.join(CURRENT_LOG);
    if current.metadata().map(|meta| meta.len()).unwrap_or(0) < MAX_LOG_BYTES {
        return Ok(());
    }
    let oldest = directory.join(format!("rotated-{MAX_ROTATED_FILES}.log"));
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (1..MAX_ROTATED_FILES).rev() {
        let from = directory.join(format!("rotated-{index}.log"));
        if from.exists() {
            fs::rename(from, directory.join(format!("rotated-{}.log", index + 1)))?;
        }
    }
    fs::rename(current, directory.join("rotated-1.log"))
}

fn cleanup_logs(directory: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let index = name
            .strip_prefix("rotated-")
            .and_then(|value| value.strip_suffix(".log"))
            .and_then(|value| value.parse::<usize>().ok());
        if index.is_some_and(|index| index > MAX_ROTATED_FILES) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn log_paths_newest_first(directory: &Path) -> Vec<PathBuf> {
    let mut paths = vec![directory.join(CURRENT_LOG)];
    paths.extend(
        (1..=MAX_ROTATED_FILES).map(|index| directory.join(format!("rotated-{index}.log"))),
    );
    paths.into_iter().filter(|path| path.exists()).collect()
}

fn redact_log_entry(entry: &mut LogEntry) {
    if let Some(fields) = &mut entry.fields {
        redact_value(fields);
    }
    entry.message = redact_text(&entry.message);
}

fn redact_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if is_sensitive_key(key) {
                    *value = Value::String("<redacted>".into());
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_value),
        Value::String(text) => *text = redact_text(text),
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("token")
        || key.contains("authorization")
        || key.contains("credential")
        || key.contains("password")
        || key.contains("transcript")
        || key == "text"
        || key == "content"
        || key.contains("audio")
}

fn redact_text(text: &str) -> String {
    let mut result = text.to_owned();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        result = result.replace(&home.to_string_lossy().to_string(), "<user-home>");
    }
    if let Some(index) = result.to_ascii_lowercase().find("bearer ") {
        result.replace_range(index + "bearer ".len().., "<redacted>");
    }
    if ["ws://", "wss://", "http://", "https://"]
        .iter()
        .any(|prefix| result.starts_with(prefix))
    {
        if let Ok(mut url) = url::Url::parse(&result) {
            url.set_query(None);
            url.set_fragment(None);
            return url.to_string();
        }
    }
    result
}

fn log_directory(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.path().app_log_dir()
}

fn log_lock() -> std::sync::MutexGuard<'static, ()> {
    LOG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn diagnostics_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(
        "diagnostics_io_failed",
        format!("diagnostics storage failed: {error}"),
        true,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{redact_text, redact_value, rotate_if_needed, write_zip, MAX_LOG_BYTES};

    #[test]
    fn redacts_credentials() {
        let mut value = json!({"accessToken": "secret", "nested": {"password": "secret"}});
        redact_value(&mut value);
        assert_eq!(value["accessToken"], "<redacted>");
        assert_eq!(value["nested"]["password"], "<redacted>");
        assert_eq!(
            redact_text("Authorization: Bearer secret"),
            "Authorization: Bearer <redacted>"
        );
    }

    #[test]
    fn rotates_a_full_log_file() {
        let directory =
            std::env::temp_dir().join(format!("mindsurf-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("test directory should exist");
        let file = std::fs::File::create(directory.join("current.log")).expect("log should exist");
        file.set_len(MAX_LOG_BYTES).expect("log should be resized");
        rotate_if_needed(&directory).expect("log should rotate");
        assert!(directory.join("rotated-1.log").exists());
        std::fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn writes_a_standard_zip_container() {
        let path = std::env::temp_dir().join(format!(
            "mindsurf-diagnostics-test-{}.zip",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        write_zip(&path, &[("README.txt", b"diagnostics".to_vec())])
            .expect("zip should be created");
        let bytes = std::fs::read(&path).expect("zip should be readable");
        assert!(bytes.starts_with(&0x0403_4b50u32.to_le_bytes()));
        assert!(bytes.windows(4).any(|window| window == b"PK\x05\x06"));
        std::fs::remove_file(path).expect("zip should be removed");
    }
}
