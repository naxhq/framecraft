//! FrameCraft desktop shell.
//!
//! Thin on purpose: the entire product runs inside the WebView (the same
//! static export GitHub Pages serves). The Rust side only provides what the
//! WebView cannot: a native save dialog for exports (anchor downloads are
//! inert inside wry), the app data directory for future offline caches, and
//! the "open with" path for `.framecraft` project files, which the operating
//! system delivers to the process rather than to the page. The web side
//! reaches all of it through `window.__TAURI__.core.invoke`
//! (`apps/web/lib/platform.ts`); no `@tauri-apps/*` JS package is bundled.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::Engine as _;
use tauri::{Emitter as _, Manager as _};
use tauri_plugin_dialog::DialogExt as _;

/// The event carrying a project the OS asked us to open while we were already
/// running. Mirrors `OPEN_PROJECT_EVENT` in `apps/web/lib/platform.ts`.
pub const OPEN_PROJECT_EVENT: &str = "framecraft://open-project";

/// The extension this build writes, and the one FrameCraft 3.0 wrote.
///
/// Both open. Only the first is REGISTERED with the operating system: a
/// double extension cannot be registered on Windows (the shell keys off the
/// last one, and claiming `.json` outright would be antisocial), so a legacy
/// file is opened through the app's own Load button, whose picker offers both.
pub const PROJECT_EXTENSION: &str = ".framecraft";
pub const LEGACY_PROJECT_EXTENSION: &str = ".framecraft.json";

/// A project file is JSON in the kilobytes; a maximal one measures 9 kB and
/// the pathological future case 369 kB. This cap is three orders of magnitude
/// above that: it exists so that pointing the association at a multi-gigabyte
/// file cannot make the app allocate it, not to constrain any real project.
const MAX_PROJECT_BYTES: u64 = 32 * 1024 * 1024;

/// A project file read off disk, ready for the page to validate.
///
/// The bytes are read HERE rather than handing the page a path, because the
/// page has no filesystem: the WebView would need the fs plugin's read
/// permission on an arbitrary path to do the same job.
#[derive(Clone, serde::Serialize)]
pub struct OpenedProject {
    /// The base name, which is what tells the page whether the file used the legacy extension.
    filename: String,
    /// The whole file as UTF-8.
    text: String,
    /// The absolute path, so a refusal can name the file it refused.
    path: String,
}

/// A project that arrived before the page could receive it.
///
/// Launching by double-click delivers the path as a process argument before
/// the WebView exists, so it is parked here until the page asks. `collected`
/// records that the page has asked at least once, which is what lets a LATER
/// open (a second double-click, or macOS's open-documents event) go straight
/// out as an event instead of sitting in a slot nobody will read again.
#[derive(Default)]
struct PendingProject {
    slot: Mutex<Option<OpenedProject>>,
    collected: AtomicBool,
}

/// True for a name this app opens: the current extension or the legacy one.
pub fn is_project_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(PROJECT_EXTENSION) || lower.ends_with(LEGACY_PROJECT_EXTENSION)
}

/// The project file in a process argument list, if there is one.
///
/// Deliberately narrow. The first argument is the executable and is always
/// skipped, and a path is only accepted when its name ends in one of this
/// app's extensions, so a stray argument can never make the app try to open
/// something arbitrary.
///
/// **The extension is the discriminator, not a leading dash.** This used to
/// skip every argument starting with `-`, which kept Tauri's dev runner and
/// the WebView runtime's own switches out but also made `-notes.framecraft`
/// impossible to open by double-click, and a leading hyphen is a name a real
/// user can give a real file (v3-13 dist audit, finding 3). No switch either
/// runtime passes ends in `.framecraft` or `.framecraft.json`, so the suffix
/// test alone does the job. Two narrower rules keep it honest:
///
/// * `--` ends the switches, exactly as it does everywhere else: after it,
///   every argument is a path, hyphen or not.
/// * before `--`, a `--name=value` switch is skipped whole, so a value that
///   happens to name a project (`--open=/tmp/loop.framecraft`) can never be
///   mistaken for the path itself.
pub fn project_path_from_args(args: &[String]) -> Option<PathBuf> {
    let mut positional_only = false;
    for arg in args.iter().skip(1) {
        if !positional_only && arg == "--" {
            positional_only = true;
            continue;
        }
        if !positional_only && arg.starts_with("--") && arg.contains('=') {
            continue;
        }
        if is_project_filename(arg) {
            return Some(PathBuf::from(arg));
        }
    }
    None
}

/// Read a project file, refusing anything implausibly large before allocating it.
fn read_project(path: &Path) -> Result<OpenedProject, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?
        .len();
    if size > MAX_PROJECT_BYTES {
        return Err(format!(
            "{} is {size} bytes, far larger than any FrameCraft project",
            path.display()
        ));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(OpenedProject {
        filename,
        text,
        path: path.display().to_string(),
    })
}

/// Hand a project to the page, or park it until the page is there to take it.
///
/// Errors are logged rather than raised: a file the OS could not give us is
/// not a reason to refuse to start, and the user still gets a window.
fn deliver_project(app: &tauri::AppHandle, path: &Path) {
    let project = match read_project(path) {
        Ok(project) => project,
        Err(message) => {
            eprintln!("FrameCraft: {message}");
            return;
        }
    };
    let pending = app.state::<PendingProject>();
    if pending.collected.load(Ordering::SeqCst) {
        // The page is live and has already drained the slot once, so an event
        // is the only thing it is still listening for.
        if let Err(error) = app.emit(OPEN_PROJECT_EVENT, project) {
            eprintln!("FrameCraft: could not deliver the opened project: {error}");
        }
        return;
    }
    park_project(&pending, project);
}

/// Put a project in the slot the page will drain on its first ask.
///
/// A separate function so the mutex guard's lifetime ends here rather than at
/// the end of the caller's block, where the `State` borrow it comes from has
/// already been dropped. A poisoned lock is recovered rather than propagated:
/// the only thing behind it is one optional value, and losing the file the
/// user just double-clicked is a worse outcome than reusing a slot whose
/// previous writer panicked.
fn park_project(pending: &PendingProject, project: OpenedProject) {
    match pending.slot.lock() {
        Ok(mut slot) => *slot = Some(project),
        Err(poisoned) => *poisoned.into_inner() = Some(project),
    }
}

/// Bring the existing window forward, for the second-instance case.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

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

/// The project this app was LAUNCHED with, taken exactly once.
///
/// Taking rather than reading: a WebView reload must not reopen a file the
/// user has since moved on from. The first call also marks the page as live,
/// after which any further open goes out as `OPEN_PROJECT_EVENT` instead.
#[tauri::command]
fn take_pending_project(state: tauri::State<'_, PendingProject>) -> Option<OpenedProject> {
    state.collected.store(true, Ordering::SeqCst);
    state.slot.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Registered FIRST, as the plugin requires: a second launch has to be
    // intercepted before the rest of the app starts building in that process.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        if let Some(path) = project_path_from_args(&argv) {
            deliver_project(app, &path);
        }
        focus_main_window(app);
    }));

    let app = builder
        .manage(PendingProject::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            save_export,
            cache_dir,
            take_pending_project
        ])
        .setup(|app| {
            // Windows and Linux hand the double-clicked path to the process as
            // an argument. macOS does not: it sends an open-documents event,
            // handled in the run loop below.
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = project_path_from_args(&args) {
                deliver_project(app.handle(), &path);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FrameCraft");

    app.run(|_app_handle, _event| {
        // macOS delivers an opened document as a run-loop event, both at
        // launch and for every later double-click while the app is running.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    deliver_project(_app_handle, &path);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn recognises_both_project_extensions() {
        assert!(is_project_filename("chicago-2026-09-03.framecraft"));
        assert!(is_project_filename("chicago-2026-09-03.framecraft.json"));
        // Case is the operating system's business, not ours.
        assert!(is_project_filename("Chicago.FrameCraft"));
        assert!(!is_project_filename("chicago.json"));
        assert!(!is_project_filename("chicago.3mf"));
        assert!(!is_project_filename("framecraft"));
    }

    #[test]
    fn finds_the_project_argument_and_never_the_executable() {
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "C:/designs/loop.framecraft"])),
            Some(PathBuf::from("C:/designs/loop.framecraft"))
        );
        // The executable itself is skipped even when it is somehow named like a project.
        assert_eq!(project_path_from_args(&args(&["loop.framecraft"])), None);
    }

    #[test]
    fn ignores_flags_and_unrelated_arguments() {
        assert_eq!(
            project_path_from_args(&args(&[
                "framecraft.exe",
                "--webview-flag=1",
                "-v",
                "/etc/passwd",
                "/home/v/loop.framecraft.json",
            ])),
            Some(PathBuf::from("/home/v/loop.framecraft.json"))
        );
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "--flag", "notes.txt"])),
            None
        );
        assert_eq!(project_path_from_args(&args(&[])), None);
    }

    /// A leading hyphen is a name a real user can give a real file, and the
    /// old filter skipped it silently (v3-13 dist audit, finding 3).
    #[test]
    fn opens_a_project_whose_name_begins_with_a_hyphen() {
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "-notes.framecraft"])),
            Some(PathBuf::from("-notes.framecraft"))
        );
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "--", "-notes.framecraft"])),
            Some(PathBuf::from("-notes.framecraft"))
        );
        // `--` ends the switches: after it a name that looks like one is still a path.
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "--", "--odd=name.framecraft"])),
            Some(PathBuf::from("--odd=name.framecraft"))
        );
    }

    /// A switch's VALUE is not the path, however much it looks like one.
    #[test]
    fn never_reads_a_project_out_of_a_name_equals_value_switch() {
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "--open=/tmp/loop.framecraft"])),
            None
        );
        // ... and the real path later in the list is still found.
        assert_eq!(
            project_path_from_args(&args(&[
                "framecraft.exe",
                "--open=/tmp/decoy.framecraft",
                "/tmp/real.framecraft",
            ])),
            Some(PathBuf::from("/tmp/real.framecraft"))
        );
    }

    /// Paths the operating system really hands over: spaces, and non-ASCII.
    #[test]
    fn accepts_paths_with_spaces_and_non_ascii() {
        assert_eq!(
            project_path_from_args(&args(&[
                "framecraft.exe",
                "C:/My Designs/São Paulo.framecraft",
            ])),
            Some(PathBuf::from("C:/My Designs/São Paulo.framecraft"))
        );
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "/home/v/設計 2026.framecraft"])),
            Some(PathBuf::from("/home/v/設計 2026.framecraft"))
        );
        // Case is the OS's business here too, including on a legacy name.
        assert_eq!(
            project_path_from_args(&args(&["framecraft.exe", "/home/v/設計.FrameCraft.JSON"])),
            Some(PathBuf::from("/home/v/設計.FrameCraft.JSON"))
        );
    }

    #[test]
    fn reads_a_project_file_with_its_name_and_refuses_a_missing_one() {
        let dir = std::env::temp_dir().join("framecraft-open-with-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("loop.framecraft");
        std::fs::write(&path, "{\"format\":\"framecraft-project\"}").expect("write");

        let project = read_project(&path).expect("read");
        assert_eq!(project.filename, "loop.framecraft");
        assert_eq!(project.text, "{\"format\":\"framecraft-project\"}");
        assert!(project.path.ends_with("loop.framecraft"));

        assert!(read_project(&dir.join("absent.framecraft")).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
