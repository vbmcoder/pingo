// src-tauri/src/screen_capture.rs
// Native Windows Screen Capture using scrap crate
// Replaces browser-based screenshot picker with fast Rust implementation

use base64::Engine;
use scrap::Capturer;

/// Capture the specified display
/// Returns image as PNG bytes that can be displayed in the UI
///
/// # Arguments
/// * `display_index` - Which display to capture (0 = primary)
///
/// # Returns
/// PNG bytes that can be converted to data URL
#[tauri::command]
pub fn capture_screen_primary() -> Result<String, String> {
    // Prefer Display::primary() when available (returns Result)
    if let Ok(d) = scrap::Display::primary() {
        return capture_display(d);
    }

    // Fallback to first display from list
    let mut displays =
        scrap::Display::all().map_err(|e| format!("Failed to get displays: {}", e))?;

    if displays.is_empty() {
        return Err("No displays found".to_string());
    }

    let display = displays.remove(0);
    capture_display(display)
}

/// Capture a specific display by index
#[tauri::command]
pub fn capture_screen(display_index: usize) -> Result<String, String> {
    let displays = scrap::Display::all().map_err(|e| format!("Failed to get displays: {}", e))?;

    let display = displays
        .into_iter()
        .nth(display_index)
        .ok_or_else(|| format!("Display {} not found", display_index))?;

    capture_display(display)
}

/// Get list of available displays with their dimensions
#[tauri::command]
pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    let displays = scrap::Display::all().map_err(|e| format!("Failed to get displays: {}", e))?;

    Ok(displays
        .into_iter()
        .enumerate()
        .map(|(i, d)| DisplayInfo {
            index: i,
            width: d.width(),
            height: d.height(),
            name: format!("Display {}", i + 1),
        })
        .collect())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DisplayInfo {
    pub index: usize,
    pub width: usize,
    pub height: usize,
    pub name: String,
}

/// Helper: Retry capturing frame with exponential backoff
/// Handles "operation would block" errors from scrap on Windows
fn capture_frame_with_retry(capturer: &mut Capturer, max_attempts: u32) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();

    for attempt in 0..max_attempts {
        match capturer.frame() {
            Ok(frame) => {
                // Frame is borrowed, so we need to convert it to owned Vec
                return Ok(frame.to_vec());
            }
            Err(e) => {
                let error_msg = e.to_string();
                last_error = error_msg.clone();

                // Only retry on "operation would block" errors
                if !error_msg.contains("would block") && !error_msg.contains("again") {
                    return Err(format!("Failed to capture frame: {}", error_msg));
                }

                // Exponential backoff: 10ms, 20ms, etc.
                if attempt < max_attempts - 1 {
                    let sleep_ms = 10 * (attempt + 1) as u64;
                    std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                }
            }
        }
    }

    Err(format!(
        "Failed to capture frame after {} attempts: {}",
        max_attempts, last_error
    ))
}

/// Internal: Capture a display and return as data URL string
fn capture_display(display: scrap::Display) -> Result<String, String> {
    let mut capturer =
        Capturer::new(display).map_err(|e| format!("Failed to create capturer: {}", e))?;

    let (w, h) = (capturer.width(), capturer.height());

    // Capture frame with retry logic for "operation would block" errors
    let frame = capture_frame_with_retry(&mut capturer, 3)?;

    // Convert BGRA format to RGBA for image crate
    let mut rgba = Vec::with_capacity(w * h * 4);
    for chunk in frame.chunks_exact(4) {
        // Input is BGRA, convert to RGBA
        rgba.push(chunk[2]); // R
        rgba.push(chunk[1]); // G
        rgba.push(chunk[0]); // B
        rgba.push(chunk[3]); // A
    }

    // Create image and encode as PNG
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
        .ok_or_else(|| "Failed to create image".to_string())?;

    // Encode as PNG bytes using DynamicImage and ImageOutputFormat
    let mut png_bytes = Vec::new();
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    dyn_img
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageOutputFormat::Png,
        )
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;

    // Convert PNG bytes to data URL
    Ok(png_bytes_to_data_url(&png_bytes))
}

/// Convert PNG bytes to data URL for display in browser
pub fn png_bytes_to_data_url(png_bytes: &[u8]) -> String {
    // Use modern base64 engine API
    let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
    format!("data:image/png;base64,{}", b64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_displays() {
        let result = list_displays();
        assert!(result.is_ok());
        let displays = result.unwrap();
        assert!(!displays.is_empty());
    }
}
