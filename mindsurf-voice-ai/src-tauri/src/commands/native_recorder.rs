use serde::Serialize;

use crate::error::{AppError, CommandResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecordingResult {
    duration_ms: f64,
    frame_count: usize,
    pcm_samples: Vec<i16>,
    sample_count: usize,
    sample_rate: u32,
    wav_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecordingMeter {
    active: bool,
    duration_ms: f64,
    level: f32,
}

#[tauri::command]
pub fn start_native_audio_recording() -> CommandResult<()> {
    match platform::start() {
        Ok(()) => CommandResult::success(()),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn stop_native_audio_recording() -> CommandResult<NativeRecordingResult> {
    match platform::stop() {
        Ok(recording) => CommandResult::success(recording),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn native_audio_recording_level() -> CommandResult<f32> {
    match platform::level() {
        Ok(level) => CommandResult::success(level),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn native_audio_recording_meter() -> CommandResult<NativeRecordingMeter> {
    match platform::meter() {
        Ok(meter) => CommandResult::success(meter),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn cancel_native_audio_recording() -> CommandResult<()> {
    match platform::cancel() {
        Ok(()) => CommandResult::success(()),
        Err(error) => CommandResult::failure(error),
    }
}

fn recorder_error(code: &str, message: impl ToString) -> AppError {
    AppError::new(code, message.to_string(), true)
}

#[cfg(any(target_os = "macos", test))]
fn parse_pcm_wav(bytes: &[u8]) -> Result<(u32, Vec<i16>), AppError> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(recorder_error(
            "native_recording_invalid",
            "native recorder did not produce a valid WAV file",
        ));
    }

    let mut offset = 12usize;
    let mut format = None;
    let mut samples = None;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_len = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .map_err(|_| recorder_error("native_recording_invalid", "invalid WAV chunk"))?,
        ) as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start.saturating_add(chunk_len);
        if chunk_end > bytes.len() {
            break;
        }

        if chunk_id == b"fmt " && chunk_len >= 16 {
            let audio_format = u16::from_le_bytes([bytes[chunk_start], bytes[chunk_start + 1]]);
            let channels = u16::from_le_bytes([bytes[chunk_start + 2], bytes[chunk_start + 3]]);
            let sample_rate =
                u32::from_le_bytes(bytes[chunk_start + 4..chunk_start + 8].try_into().map_err(
                    |_| recorder_error("native_recording_invalid", "invalid WAV format"),
                )?);
            let bits_per_sample =
                u16::from_le_bytes([bytes[chunk_start + 14], bytes[chunk_start + 15]]);
            format = Some((audio_format, channels, sample_rate, bits_per_sample));
        } else if chunk_id == b"data" {
            let mut pcm = Vec::with_capacity(chunk_len / 2);
            for pair in bytes[chunk_start..chunk_end].chunks_exact(2) {
                pcm.push(i16::from_le_bytes([pair[0], pair[1]]));
            }
            samples = Some(pcm);
        }

        offset = chunk_end + (chunk_len % 2);
    }

    let Some((audio_format, channels, sample_rate, bits_per_sample)) = format else {
        return Err(recorder_error(
            "native_recording_invalid",
            "WAV format metadata is missing",
        ));
    };
    if audio_format != 1 || channels != 1 || bits_per_sample != 16 {
        return Err(recorder_error(
            "native_recording_invalid",
            "native WAV must contain mono 16-bit PCM audio",
        ));
    }
    let samples = samples
        .ok_or_else(|| recorder_error("native_recording_invalid", "WAV audio data is missing"))?;
    Ok((sample_rate, samples))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use objc2::rc::{Allocated, Retained};
    use objc2::{extern_class, extern_conformance, extern_methods, AnyThread};
    use objc2_foundation::{
        NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL,
    };

    use super::{
        parse_pcm_wav, recorder_error, AppError, NativeRecordingMeter, NativeRecordingResult,
    };

    const TARGET_SAMPLE_RATE: u32 = 16_000;
    const SAMPLES_PER_FRAME: usize = 320;
    static STATE: Mutex<Option<NativeRecording>> = Mutex::new(None);

    struct NativeRecording {
        path: PathBuf,
        recorder: usize,
    }

    extern_class!(
        #[unsafe(super(NSObject))]
        struct AVAudioRecorder;
    );

    extern_conformance!(
        unsafe impl NSObjectProtocol for AVAudioRecorder {}
    );

    impl AVAudioRecorder {
        extern_methods!(
            #[unsafe(method(initWithURL:settings:error:_))]
            #[unsafe(method_family = init)]
            unsafe fn init_with_url_settings_error(
                this: Allocated<Self>,
                url: &NSURL,
                settings: &NSDictionary<NSString, NSNumber>,
            ) -> Result<Retained<Self>, Retained<NSError>>;

            #[unsafe(method(prepareToRecord))]
            #[unsafe(method_family = none)]
            unsafe fn prepare_to_record(&self) -> bool;

            #[unsafe(method(record))]
            #[unsafe(method_family = none)]
            unsafe fn record(&self) -> bool;

            #[unsafe(method(setMeteringEnabled:))]
            #[unsafe(method_family = none)]
            unsafe fn set_metering_enabled(&self, enabled: bool);

            #[unsafe(method(updateMeters))]
            #[unsafe(method_family = none)]
            unsafe fn update_meters(&self);

            #[unsafe(method(averagePowerForChannel:))]
            #[unsafe(method_family = none)]
            unsafe fn average_power_for_channel(&self, channel_number: isize) -> f32;

            #[unsafe(method(currentTime))]
            #[unsafe(method_family = none)]
            unsafe fn current_time(&self) -> f64;

            #[unsafe(method(stop))]
            #[unsafe(method_family = none)]
            unsafe fn stop(&self);
        );
    }

    pub fn start() -> Result<(), AppError> {
        let mut state = STATE.lock().map_err(|_| state_error())?;
        if state.is_some() {
            return Err(recorder_error(
                "native_recording_active",
                "native audio recording is already active",
            ));
        }

        let path = std::env::temp_dir().join(format!(
            "mindsurf-native-{}-{}.wav",
            std::process::id(),
            timestamp_ms()
        ));
        let path_string = path
            .to_str()
            .ok_or_else(|| recorder_error("native_recording_unavailable", "invalid temp path"))?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(path_string));
        let keys = [
            NSString::from_str("AVFormatIDKey"),
            NSString::from_str("AVSampleRateKey"),
            NSString::from_str("AVNumberOfChannelsKey"),
            NSString::from_str("AVLinearPCMBitDepthKey"),
            NSString::from_str("AVLinearPCMIsBigEndianKey"),
            NSString::from_str("AVLinearPCMIsFloatKey"),
            NSString::from_str("AVLinearPCMIsNonInterleavedKey"),
        ];
        let values = [
            NSNumber::new_u32(u32::from_be_bytes(*b"lpcm")),
            NSNumber::new_f64(f64::from(TARGET_SAMPLE_RATE)),
            NSNumber::new_u32(1),
            NSNumber::new_u32(16),
            NSNumber::new_bool(false),
            NSNumber::new_bool(false),
            NSNumber::new_bool(false),
        ];
        let key_refs: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
        let settings = NSDictionary::from_retained_objects(&key_refs, &values);

        let recorder = unsafe {
            AVAudioRecorder::init_with_url_settings_error(AVAudioRecorder::alloc(), &url, &settings)
        }
        .map_err(|error| {
            recorder_error(
                "native_recording_unavailable",
                format!("AVAudioRecorder initialization failed: {error:?}"),
            )
        })?;

        unsafe { recorder.set_metering_enabled(true) };
        if !unsafe { recorder.prepare_to_record() } || !unsafe { recorder.record() } {
            return Err(recorder_error(
                "native_recording_unavailable",
                "AVAudioRecorder could not start microphone capture",
            ));
        }

        let recorder = Retained::into_raw(recorder) as usize;
        *state = Some(NativeRecording { path, recorder });
        #[cfg(debug_assertions)]
        eprintln!("native recorder: started");
        Ok(())
    }

    pub fn level() -> Result<f32, AppError> {
        Ok(meter()?.level)
    }

    pub fn meter() -> Result<NativeRecordingMeter, AppError> {
        let state = STATE.lock().map_err(|_| state_error())?;
        let Some(recording) = state.as_ref() else {
            return Ok(NativeRecordingMeter {
                active: false,
                duration_ms: 0.0,
                level: 0.0,
            });
        };
        let recorder = unsafe { &*(recording.recorder as *mut AVAudioRecorder) };
        unsafe { recorder.update_meters() };
        let decibels = unsafe { recorder.average_power_for_channel(0) };

        // AVAudioRecorder reports RMS power in dBFS. Match the browser recorder's
        // visible range (RMS * 4) so both implementations drive the same meter.
        Ok(NativeRecordingMeter {
            active: true,
            duration_ms: unsafe { recorder.current_time() } * 1_000.0,
            level: (10.0_f32.powf(decibels / 20.0) * 4.0).clamp(0.0, 1.0),
        })
    }

    pub fn stop() -> Result<NativeRecordingResult, AppError> {
        let recording = STATE
            .lock()
            .map_err(|_| state_error())?
            .take()
            .ok_or_else(|| {
                recorder_error(
                    "native_recording_inactive",
                    "native audio recording is not active",
                )
            })?;
        let recorder = unsafe {
            Retained::from_raw(recording.recorder as *mut AVAudioRecorder)
                .ok_or_else(state_error)?
        };
        unsafe { recorder.stop() };
        drop(recorder);

        let wav_bytes = std::fs::read(&recording.path).map_err(|error| {
            recorder_error(
                "native_recording_unavailable",
                format!("unable to read native recording: {error}"),
            )
        })?;
        let _ = std::fs::remove_file(&recording.path);
        let (sample_rate, pcm_samples) = parse_pcm_wav(&wav_bytes)?;
        let sample_count = pcm_samples.len();
        let frame_count = sample_count.div_ceil(SAMPLES_PER_FRAME);
        let duration_ms = sample_count as f64 / f64::from(sample_rate) * 1_000.0;
        #[cfg(debug_assertions)]
        eprintln!(
            "native recorder: stopped samples={sample_count}, rate={sample_rate}, duration_ms={duration_ms:.0}"
        );

        Ok(NativeRecordingResult {
            duration_ms,
            frame_count,
            pcm_samples,
            sample_count,
            sample_rate,
            wav_bytes,
        })
    }

    pub fn cancel() -> Result<(), AppError> {
        let Some(recording) = STATE.lock().map_err(|_| state_error())?.take() else {
            return Ok(());
        };
        let recorder = unsafe {
            Retained::from_raw(recording.recorder as *mut AVAudioRecorder)
                .ok_or_else(state_error)?
        };
        unsafe { recorder.stop() };
        drop(recorder);
        let _ = std::fs::remove_file(recording.path);
        #[cfg(debug_assertions)]
        eprintln!("native recorder: cancelled");
        Ok(())
    }

    fn state_error() -> AppError {
        recorder_error(
            "native_recording_unavailable",
            "native recorder state is unavailable",
        )
    }

    fn timestamp_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{recorder_error, AppError, NativeRecordingMeter, NativeRecordingResult};

    pub fn start() -> Result<(), AppError> {
        Err(unavailable())
    }

    pub fn stop() -> Result<NativeRecordingResult, AppError> {
        Err(unavailable())
    }

    pub fn level() -> Result<f32, AppError> {
        Err(unavailable())
    }

    pub fn meter() -> Result<NativeRecordingMeter, AppError> {
        Err(unavailable())
    }

    pub fn cancel() -> Result<(), AppError> {
        Ok(())
    }

    fn unavailable() -> AppError {
        recorder_error(
            "native_recording_unsupported",
            "native audio recording is only available on macOS",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::parse_pcm_wav;

    #[test]
    fn parses_mono_pcm_wav() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&40u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&123i16.to_le_bytes());
        wav.extend_from_slice(&(-456i16).to_le_bytes());

        let (sample_rate, samples) = parse_pcm_wav(&wav).expect("valid WAV");
        assert_eq!(sample_rate, 16_000);
        assert_eq!(samples, vec![123, -456]);
    }
}
