//! Desktop auth handoff: log the local user in without showing them a password
//! prompt for their own machine.
//!
//! No server change is involved. The sidecar's zero-config first run (#109)
//! generates the admin password and persists it in `auth-bootstrap.json`
//! (mode 0600) inside the data directory; the shell reads that file and has the
//! webview POST it to the existing `/api/auth/login` route, which sets the
//! `auth-token` cookie in the webview's own cookie jar. The server binds
//! loopback only, so the credential never leaves the machine, and the file stays
//! the documented fallback if the handoff ever fails.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Default admin account of the local auth provider (`src/lib/local-auth.ts`).
pub const ADMIN_EMAIL: &str = "admin@libredb.org";

/// Credentials file written by `src/lib/auth-bootstrap.ts`.
pub const BOOTSTRAP_FILE: &str = "auth-bootstrap.json";

/// Path of the login page the handoff runs on.
pub const LOGIN_PATH: &str = "/login";

/// Location of the bootstrap file for a given data directory.
pub fn bootstrap_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BOOTSTRAP_FILE)
}

/// Extract `adminPassword` from the bootstrap file's JSON.
///
/// Anything unexpected (corrupt JSON, missing or empty field, wrong type) yields
/// `None`: the shell then leaves the login form up rather than guessing.
pub fn admin_password_from_json(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let password = parsed.get("adminPassword")?.as_str()?;
    if password.is_empty() {
        return None;
    }
    Some(password.to_string())
}

/// Poll for the bootstrap file until it carries a password.
///
/// The file is written during server boot, so it normally exists by the time the
/// health gate passes; the short poll covers the write landing a beat later.
pub fn wait_for_admin_password<S>(
    data_dir: &Path,
    deadline: Duration,
    interval: Duration,
    mut sleep: S,
) -> Option<String>
where
    S: FnMut(Duration),
{
    let path = bootstrap_path(data_dir);
    let started = Instant::now();
    loop {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Some(password) = admin_password_from_json(&raw) {
                return Some(password);
            }
        }
        if started.elapsed() >= deadline {
            return None;
        }
        sleep(interval);
    }
}

/// True for the served login page (the only page the handoff should run on).
pub fn is_login_url(url: &str) -> bool {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let path = match after_scheme.find('/') {
        Some(index) => &after_scheme[index..],
        None => "/",
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    path == LOGIN_PATH || path == "/login/"
}

/// Script evaluated in the webview on the login page: submit the credentials to
/// the existing login route, then replace the login page with the workspace.
///
/// Values are embedded through `serde_json` so a password containing quotes or
/// backslashes cannot break out of the literal.
pub fn login_script(email: &str, password: &str) -> String {
    let email = serde_json::to_string(email).unwrap_or_else(|_| "\"\"".to_string());
    let password = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  if (window.__libredbDesktopHandoff) return;
  window.__libredbDesktopHandoff = true;
  fetch("/api/auth/login", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    credentials: "same-origin",
    body: JSON.stringify({{ email: {email}, password: {password} }}),
  }})
    .then((response) => {{
      if (response.ok) window.location.replace("/");
    }})
    .catch(() => {{}});
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("libredb-handoff-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn reads_the_password_out_of_the_bootstrap_file() {
        let raw = r#"{"jwtSecret":"x","adminPassword":"s3cr3t","createdAt":"2026-07-28T00:00:00.000Z"}"#;
        assert_eq!(admin_password_from_json(raw), Some("s3cr3t".to_string()));
    }

    #[test]
    fn rejects_unusable_bootstrap_contents() {
        assert_eq!(admin_password_from_json("not json"), None);
        assert_eq!(admin_password_from_json("null"), None);
        assert_eq!(admin_password_from_json("[]"), None);
        assert_eq!(admin_password_from_json(r#"{"jwtSecret":"x"}"#), None);
        assert_eq!(admin_password_from_json(r#"{"adminPassword":42}"#), None);
        assert_eq!(admin_password_from_json(r#"{"adminPassword":""}"#), None);
    }

    #[test]
    fn bootstrap_path_sits_next_to_the_storage_database() {
        assert_eq!(
            bootstrap_path(Path::new("/data")),
            PathBuf::from("/data/auth-bootstrap.json")
        );
    }

    #[test]
    fn waits_until_the_bootstrap_file_appears() {
        let dir = temp_dir("appears");
        let path = bootstrap_path(&dir);
        let _ = fs::remove_file(&path);
        let calls = AtomicUsize::new(0);
        let password = wait_for_admin_password(&dir, Duration::from_secs(2), Duration::from_millis(10), |_| {
            // Write the file on the second poll: proves the loop re-reads.
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                fs::write(&path, r#"{"adminPassword":"late"}"#).expect("write");
            }
        });
        assert_eq!(password, Some("late".to_string()));
        assert!(calls.load(Ordering::SeqCst) >= 2);
        fs::remove_file(&path).expect("cleanup");
    }

    #[test]
    fn gives_up_when_no_password_is_ever_written() {
        let dir = temp_dir("never");
        let _ = fs::remove_file(bootstrap_path(&dir));
        let password = wait_for_admin_password(&dir, Duration::from_millis(20), Duration::from_millis(10), |_| {});
        assert_eq!(password, None);
    }

    #[test]
    fn recognizes_only_the_login_page() {
        assert!(is_login_url("http://127.0.0.1:41234/login"));
        assert!(is_login_url("http://127.0.0.1:41234/login/"));
        assert!(is_login_url("http://127.0.0.1:41234/login?next=%2F"));
        assert!(is_login_url("/login"));
        assert!(!is_login_url("http://127.0.0.1:41234/"));
        assert!(!is_login_url("http://127.0.0.1:41234/admin"));
        assert!(!is_login_url("http://127.0.0.1:41234/login-help"));
        assert!(!is_login_url("tauri://localhost"));
    }

    #[test]
    fn login_script_escapes_the_injected_credentials() {
        let script = login_script("admin@libredb.org", "pa\"ss\\word\n");
        assert!(script.contains(r#"email: "admin@libredb.org""#));
        assert!(script.contains(r#"password: "pa\"ss\\word\n""#));
        assert!(script.contains("/api/auth/login"));
        assert!(script.contains("window.location.replace(\"/\")"));
        // Guard against a double submit if the page load event fires twice.
        assert!(script.contains("__libredbDesktopHandoff"));
    }
}
