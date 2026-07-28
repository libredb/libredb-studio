//! LibreDB Studio desktop shell.
//!
//! The shell owns three things and nothing else: a webview, the sidecar process
//! that serves the app on loopback, and the handoff that logs the local user in.
//! All application behaviour lives in the standalone Next.js payload, exactly as
//! it is shipped to Docker, npx, deb/rpm and Snap - the desktop build adds no
//! second implementation of anything.
//!
//! Boot sequence:
//! 1. show the bundled splash page immediately (the webview is up before the
//!    server is),
//! 2. pick a free loopback port and spawn `node server.js` from the bundled
//!    payload with `STORAGE_PROVIDER=sqlite` pointed at the per-user data dir,
//! 3. wait for `GET /api/db/health` to answer 200 (30 s deadline),
//! 4. read the admin password the server's zero-config bootstrap persisted and
//!    navigate the webview to `/login`, where the handoff script signs in,
//! 5. supervise: restart with backoff if the sidecar dies, and always take it
//!    down with the shell.

pub mod backoff;
pub mod handoff;
pub mod layout;
pub mod net;
pub mod sidecar;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent, Webview, WebviewWindow, Wry};

use crate::sidecar::{Sidecar, SHUTDOWN_GRACE};

/// Target triple of this build, recorded by build.rs - used to find the
/// checked-in `bin/node-<triple>` sidecar during `tauri dev`.
pub const TARGET_TRIPLE: &str = env!("LIBREDB_TARGET_TRIPLE");

/// Storage database file name inside the per-user data directory. Matches the
/// default in `src/lib/data-dir.ts` so the desktop app and a manually launched
/// server agree on the layout.
pub const STORAGE_DB_FILE: &str = "libredb-storage.db";

/// Label of the window declared in tauri.conf.json.
const MAIN_WINDOW: &str = "main";

/// Prefix for the shell's own stderr lines (the sidecar's are tagged `[server]`).
const LOG_PREFIX: &str = "[libredb-studio]";

/// How long the server may take to answer the health check before the shell
/// gives up on this attempt (mirrors the release smoke test's 30 s budget).
const HEALTH_DEADLINE: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(400);

/// The bootstrap credentials file is written during server boot; by the time
/// health passes it is normally there already.
const PASSWORD_DEADLINE: Duration = Duration::from_secs(10);
const PASSWORD_INTERVAL: Duration = Duration::from_millis(200);

/// How often the supervisor checks that the sidecar is still alive.
const SUPERVISE_INTERVAL: Duration = Duration::from_millis(750);

/// Shared shell state: the sidecar handle and the password the handoff needs.
#[derive(Default)]
pub struct DesktopState {
    sidecar: Mutex<Option<Sidecar>>,
    password: Mutex<Option<String>>,
    /// Set once the app is exiting, so the supervisor cannot read the sidecar's
    /// death as a crash and restart it on the way out.
    shutting_down: AtomicBool,
}

impl DesktopState {
    fn set_sidecar(&self, sidecar: Sidecar) {
        if let Ok(mut slot) = self.sidecar.lock() {
            // Replacing the previous handle drops it, which shuts down any
            // process that somehow outlived its supervisor.
            *slot = Some(sidecar);
        }
    }

    fn sidecar_running(&self) -> bool {
        self.sidecar
            .lock()
            .map(|mut slot| slot.as_mut().is_some_and(Sidecar::is_running))
            .unwrap_or(false)
    }

    fn log_text(&self) -> String {
        self.sidecar
            .lock()
            .map(|slot| slot.as_ref().map(Sidecar::log_text).unwrap_or_default())
            .unwrap_or_default()
    }

    fn set_password(&self, password: Option<String>) {
        if let Ok(mut slot) = self.password.lock() {
            *slot = password;
        }
    }

    /// Password for the handoff, if the server produced one.
    pub fn password(&self) -> Option<String> {
        self.password.lock().ok().and_then(|slot| slot.clone())
    }

    /// Stop the sidecar without ending supervision (the boot-timeout path, which
    /// wants a fresh attempt on a fresh port).
    fn stop_sidecar(&self) {
        if let Ok(mut slot) = self.sidecar.lock() {
            if let Some(mut sidecar) = slot.take() {
                sidecar.shutdown(SHUTDOWN_GRACE);
            }
        }
    }

    /// True once [`Self::shutdown`] has been called.
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Stop the sidecar for good. Idempotent, and safe to call from the exit
    /// handler; the supervisor thread observes the flag and stops restarting.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop_sidecar();
    }
}

/// Build the JS call that turns the splash page into an error report.
pub fn failure_script(summary: &str, detail: &str) -> String {
    let summary = serde_json::to_string(summary).unwrap_or_else(|_| "\"\"".to_string());
    let detail = serde_json::to_string(detail).unwrap_or_else(|_| "\"\"".to_string());
    format!("window.__libredbDesktopFailure && window.__libredbDesktopFailure({summary}, {detail});")
}

/// Entry point called by `main.rs`.
pub fn run() {
    let app = tauri::Builder::default()
        .manage(DesktopState::default())
        .on_page_load(on_page_load)
        .setup(|app| {
            let handle = app.handle().clone();
            // The boot sequence blocks on the health gate, so it must not run on
            // the UI thread - the splash would never paint.
            thread::spawn(move || boot(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start the LibreDB Studio desktop shell");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = handle.try_state::<DesktopState>() {
                state.shutdown();
            }
        }
    });
}

/// Run the handoff when the served login page finishes loading.
fn on_page_load(webview: &Webview<Wry>, payload: &tauri::webview::PageLoadPayload<'_>) {
    if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
        return;
    }
    if !handoff::is_login_url(payload.url().as_str()) {
        return;
    }
    let Some(password) = webview.state::<DesktopState>().password() else {
        // No credential to hand off: leave the login form to the user, and say
        // where the password is instead of failing silently.
        eprintln!("{LOG_PREFIX} no generated password found; sign in manually (see auth-bootstrap.json)");
        return;
    };
    match webview.eval(handoff::login_script(handoff::ADMIN_EMAIL, &password)) {
        Ok(()) => eprintln!("{LOG_PREFIX} signing in as {}", handoff::ADMIN_EMAIL),
        Err(error) => eprintln!("{LOG_PREFIX} could not run the sign-in script: {error}"),
    }
}

/// Resolve the per-user data directory, creating it on first run.
fn data_dir(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    // app_data_dir() is $XDG_DATA_HOME/<identifier> on Linux, which becomes
    // ~/.var/app/org.libredb.Studio/data/org.libredb.Studio inside Flatpak - a
    // writable location in both the sandboxed and the plain AppImage case.
    let dir = handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve the application data directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    Ok(dir)
}

fn boot(handle: tauri::AppHandle) {
    let window = handle.get_webview_window(MAIN_WINDOW);
    match supervise(&handle, window.as_ref()) {
        Ok(()) => {}
        Err(message) => {
            let detail = handle
                .try_state::<DesktopState>()
                .map(|state| state.log_text())
                .unwrap_or_default();
            if let Some(window) = window.as_ref() {
                let _ = window.eval(failure_script(&message, &detail));
            }
            eprintln!("LibreDB Studio desktop: {message}\n{detail}");
        }
    }
}

/// Boot the sidecar, hand off, then keep it alive until the app exits.
fn supervise(handle: &tauri::AppHandle, window: Option<&WebviewWindow>) -> Result<(), String> {
    let state = handle
        .try_state::<DesktopState>()
        .ok_or_else(|| "desktop state is not initialized".to_string())?;

    let data_dir = data_dir(handle)?;
    let storage_db = data_dir.join(STORAGE_DB_FILE);
    let exe = std::env::current_exe().map_err(|error| format!("could not locate the shell binary: {error}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "the shell binary has no parent directory".to_string())?;
    let resource_dir = handle
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve the resource directory: {error}"))?;
    let layout = layout::resolve(exe_dir, &resource_dir, TARGET_TRIPLE).map_err(|missing| missing.to_string())?;

    eprintln!("{LOG_PREFIX} data directory {}", data_dir.display());
    eprintln!("{LOG_PREFIX} server payload {}", layout.payload_dir.display());

    let mut attempt = 0usize;
    loop {
        let port = net::pick_free_port().map_err(|error| format!("no free loopback port: {error}"))?;
        eprintln!("{LOG_PREFIX} starting the server on 127.0.0.1:{port}");
        let sidecar = Sidecar::spawn(&layout, port, &storage_db)
            .map_err(|error| format!("could not start the server process: {error}"))?;
        state.set_sidecar(sidecar);

        match net::wait_for_health(
            port,
            HEALTH_DEADLINE,
            HEALTH_INTERVAL,
            || state.sidecar_running(),
            thread::sleep,
        ) {
            net::HealthOutcome::Healthy => {
                let password = handoff::wait_for_admin_password(
                    &data_dir,
                    PASSWORD_DEADLINE,
                    PASSWORD_INTERVAL,
                    thread::sleep,
                );
                eprintln!(
                    "{LOG_PREFIX} server is healthy; generated credentials {}",
                    if password.is_some() { "found" } else { "NOT found" }
                );
                state.set_password(password);
                if let Some(window) = window {
                    // Always open the workspace, never /login directly: with a
                    // session already in the webview's cookie jar the user lands
                    // straight in the workspace, and without one the server
                    // redirects to /login, where the handoff signs in and comes
                    // back here. Navigating to /login instead would send a
                    // returning admin to the admin dashboard, so the landing page
                    // would differ between first and later launches.
                    let url = format!("http://127.0.0.1:{port}/");
                    let parsed = tauri::Url::parse(&url).map_err(|error| format!("invalid server URL {url}: {error}"))?;
                    window
                        .navigate(parsed)
                        .map_err(|error| format!("could not open {url}: {error}"))?;
                }
                // Healthy: supervise until the process exits (normally never).
                while state.sidecar_running() {
                    thread::sleep(SUPERVISE_INTERVAL);
                }
            }
            net::HealthOutcome::Exited => {}
            net::HealthOutcome::Timeout => {
                state.stop_sidecar();
            }
        }

        // The app is on its way out and took the sidecar with it: that is not a
        // crash to recover from, and restarting here would outlive the window.
        if state.is_shutting_down() {
            return Ok(());
        }

        match backoff::restart_delay(attempt) {
            Some(delay) => {
                attempt += 1;
                thread::sleep(delay);
            }
            None => {
                return Err(format!(
                    "the LibreDB Studio server stopped {} times in a row and was not restarted again.",
                    backoff::MAX_RESTARTS + 1
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_starts_empty_and_reports_no_running_sidecar() {
        let state = DesktopState::default();
        assert!(!state.sidecar_running());
        assert_eq!(state.password(), None);
        assert_eq!(state.log_text(), "");
        assert!(!state.is_shutting_down());
        // Shutting down without a sidecar must be a no-op, not a panic.
        state.shutdown();
        assert!(state.is_shutting_down());
    }

    #[test]
    fn stopping_the_sidecar_is_not_a_shutdown() {
        // The boot-timeout path stops the child and tries again on a fresh port;
        // only an app exit may end supervision.
        let state = DesktopState::default();
        state.stop_sidecar();
        assert!(!state.is_shutting_down());
    }

    #[test]
    fn password_round_trips_through_shared_state() {
        let state = DesktopState::default();
        state.set_password(Some("hunter2".to_string()));
        assert_eq!(state.password(), Some("hunter2".to_string()));
        state.set_password(None);
        assert_eq!(state.password(), None);
    }

    #[test]
    fn state_tracks_and_stops_a_real_child() {
        use std::process::{Command, Stdio};
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 120")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let state = DesktopState::default();
        state.set_sidecar(Sidecar::start(command).expect("spawn"));
        assert!(state.sidecar_running());
        state.shutdown();
        assert!(!state.sidecar_running());
    }

    #[test]
    fn failure_script_escapes_both_arguments() {
        let script = failure_script("It \"broke\"", "line1\nline2\\end");
        assert!(script.starts_with("window.__libredbDesktopFailure && window.__libredbDesktopFailure("));
        assert!(script.contains(r#""It \"broke\"""#));
        assert!(script.contains(r#""line1\nline2\\end""#));
    }

    #[test]
    fn the_target_triple_is_recorded_at_build_time() {
        assert!(!TARGET_TRIPLE.is_empty());
        assert!(TARGET_TRIPLE.contains('-'), "unexpected triple: {TARGET_TRIPLE}");
    }
}
