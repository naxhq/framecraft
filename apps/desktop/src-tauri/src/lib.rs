//! FrameCraft desktop shell.
//!
//! Thin on purpose: the entire product runs inside the WebView (the same
//! static export GitHub Pages serves). The Rust side only provides what the
//! WebView cannot: a native save dialog for exports (anchor downloads are
//! inert inside wry) and the app data directory for future offline caches.
//! The web side reaches these through `window.__TAURI__.core.invoke`
//! (`apps/web/lib/platform.ts`); no `@tauri-apps/*` JS package is bundled.

use base64::Engine as _;
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt as _;

/// Open a native save dialog pre-filled with `filename` and write the
/// base64-decoded payload to the chosen path. Returns the written path, or
/// `None` when the user cancels the dialog. The payload crosses the IPC
/// boundary as base64 because Tauri's JSON IPC would otherwise serialise a
/// multi-megabyte 3MF as a number-per-byte array.
#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    filename: String,
    data_base64: String,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;

    // Blocking is fine here: async commands run off the main thread, and a
    // save dialog is modal from the user's point of view anyway.
    let picked = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// The app data directory (created on first call), for future offline caches.
#[tauri::command]
fn cache_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![save_export, cache_dir])
        .run(tauri::generate_context!())
        .expect("error while running FrameCraft");
}
