//! The sidecar: `node server.js` from the bundled payload, owned by the shell.
//!
//! Everything the server needs arrives through the environment - the standalone
//! payload reads no config files - so the wrapper's whole contract with the
//! server is [`sidecar_env`] plus the data directory it points at.

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::layout::Layout;

/// How long a SIGTERM'd sidecar gets to exit before it is killed outright.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Lines of sidecar output kept for the failure dialog.
const LOG_TAIL_LINES: usize = 200;

/// Environment variables that would break the desktop contract if inherited
/// from the launching shell.
///
/// `ADMIN_PASSWORD` and `AUTH_BOOTSTRAP` are load-bearing: the auth handoff
/// reads the password the server persisted in `auth-bootstrap.json`, which only
/// happens when the server generates it itself (`src/lib/auth-bootstrap.ts`).
/// The storage vars are cleared so a developer's `.envrc` cannot silently point
/// the desktop app at a Postgres storage backend.
pub const CLEARED_VARS: &[&str] = &[
    "ADMIN_PASSWORD",
    "ADMIN_EMAIL",
    "AUTH_BOOTSTRAP",
    "JWT_SECRET",
    "USER_PASSWORD",
    "USER_EMAIL",
    "STORAGE_POSTGRES_URL",
    "NODE_OPTIONS",
];

/// The environment the sidecar is started with.
///
/// Deliberately absent: `JWT_SECRET` and `ADMIN_PASSWORD`. Leaving them unset
/// hands credential generation to the server's zero-config first run (#109),
/// which persists both in `auth-bootstrap.json` (mode 0600) next to the storage
/// database - so sessions survive restarts and the file stays the documented
/// fallback if the automatic handoff ever fails.
pub fn sidecar_env(port: u16, storage_db: &Path) -> Vec<(String, String)> {
    vec![
        ("NODE_ENV".to_string(), "production".to_string()),
        ("NEXT_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        // The parent process' HOSTNAME (the machine name on most desktops)
        // would otherwise become the server's bind address.
        ("HOSTNAME".to_string(), "127.0.0.1".to_string()),
        ("PORT".to_string(), port.to_string()),
        ("STORAGE_PROVIDER".to_string(), "sqlite".to_string()),
        ("STORAGE_SQLITE_PATH".to_string(), storage_db.display().to_string()),
    ]
}

/// Build the sidecar command without running it (kept separate so tests can
/// assert the exact program, arguments and environment).
pub fn build_command(layout: &Layout, port: u16, storage_db: &Path) -> Command {
    let mut command = Command::new(&layout.node);
    command
        .arg(layout.server_entry())
        .current_dir(&layout.payload_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in CLEARED_VARS {
        command.env_remove(name);
    }
    command.envs(sidecar_env(port, storage_db));
    // A SIGKILLed (or SIGTERMed) shell never runs its exit handler, so the
    // kernel-level parent-death signal is the only thing that stops the server
    // from outliving the window and holding the storage database open.
    attach_parent_death_signal(&mut command);
    command
}

/// Bounded ring buffer of the sidecar's most recent output lines.
#[derive(Debug, Default)]
pub struct LogTail {
    lines: VecDeque<String>,
}

impl LogTail {
    pub fn push(&mut self, line: String) {
        if self.lines.len() == LOG_TAIL_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    pub fn text(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

/// A running sidecar process plus the tail of its output.
pub struct Sidecar {
    child: Child,
    log: Arc<Mutex<LogTail>>,
}

impl Sidecar {
    /// Start a prepared command and begin draining its output.
    pub fn start(mut command: Command) -> io::Result<Self> {
        let mut child = command.spawn()?;
        let log = Arc::new(Mutex::new(LogTail::default()));
        if let Some(stdout) = child.stdout.take() {
            drain(stdout, Arc::clone(&log));
        }
        if let Some(stderr) = child.stderr.take() {
            drain(stderr, Arc::clone(&log));
        }
        Ok(Self { child, log })
    }

    /// Start the sidecar for a resolved layout.
    pub fn spawn(layout: &Layout, port: u16, storage_db: &Path) -> io::Result<Self> {
        Self::start(build_command(layout, port, storage_db))
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn log_text(&self) -> String {
        self.log.lock().map(|log| log.text()).unwrap_or_default()
    }

    /// Ask the sidecar to exit, then make sure it did.
    ///
    /// SIGTERM first so Next.js can close listeners and better-sqlite3 can
    /// finalize; SIGKILL only after the grace period. Returns true when the
    /// process was still alive and had to be signalled.
    pub fn shutdown(&mut self, grace: Duration) -> bool {
        if !self.is_running() {
            return false;
        }
        terminate(&self.child);
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if !self.is_running() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        true
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Last line of defence: a dropped Sidecar must never leave an orphaned
        // server holding the storage database open.
        self.shutdown(SHUTDOWN_GRACE);
    }
}

fn drain<R: io::Read + Send + 'static>(reader: R, log: Arc<Mutex<LogTail>>) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { return };
            // Also forward to our own stderr: launched from a terminal, the whole
            // server log is then visible without reproducing a failure first,
            // which is what a bug report needs.
            eprintln!("[server] {line}");
            if let Ok(mut log) = log.lock() {
                log.push(line);
            }
        }
    });
}

#[cfg(unix)]
fn terminate(child: &Child) {
    // SAFETY: `child` is alive (checked by the caller via try_wait), so its pid
    // has not been recycled, and SIGTERM has no side effects on this process.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn terminate(_child: &Child) {
    // Windows has no SIGTERM; the shutdown path falls through to kill().
}

/// Tie the sidecar's lifetime to the shell process on Linux: if the shell is
/// SIGKILLed (or the compositor kills it), the kernel sends the child SIGTERM
/// instead of leaving an orphan bound to the storage database.
#[cfg(target_os = "linux")]
pub fn attach_parent_death_signal(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl(PR_SET_PDEATHSIG) only touches the calling (child) thread
    // state after fork and is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
pub fn attach_parent_death_signal(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::PathBuf;

    fn layout() -> Layout {
        Layout {
            node: PathBuf::from("/app/bin/node"),
            payload_dir: PathBuf::from("/app/lib/payload"),
        }
    }

    #[test]
    fn env_pins_loopback_sqlite_storage_and_the_chosen_port() {
        let env = sidecar_env(41234, Path::new("/data/libredb-storage.db"));
        let lookup = |key: &str| {
            env.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(lookup("PORT"), Some("41234"));
        assert_eq!(lookup("HOSTNAME"), Some("127.0.0.1"));
        assert_eq!(lookup("STORAGE_PROVIDER"), Some("sqlite"));
        assert_eq!(lookup("STORAGE_SQLITE_PATH"), Some("/data/libredb-storage.db"));
        assert_eq!(lookup("NODE_ENV"), Some("production"));
    }

    #[test]
    fn env_leaves_credentials_to_the_servers_zero_config_bootstrap() {
        let env = sidecar_env(3000, Path::new("/data/libredb-storage.db"));
        for key in ["JWT_SECRET", "ADMIN_PASSWORD", "AUTH_BOOTSTRAP"] {
            assert!(!env.iter().any(|(name, _)| name == key), "{key} must not be set");
        }
    }

    #[test]
    fn command_runs_server_js_from_the_payload_directory() {
        let layout = layout();
        let command = build_command(&layout, 3210, Path::new("/data/libredb-storage.db"));
        assert_eq!(command.get_program(), OsStr::new("/app/bin/node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![OsStr::new("/app/lib/payload/server.js")]);
        assert_eq!(command.get_current_dir(), Some(Path::new("/app/lib/payload")));
    }

    #[test]
    fn command_clears_inherited_auth_and_storage_overrides() {
        let command = build_command(&layout(), 3210, Path::new("/data/libredb-storage.db"));
        let cleared: Vec<_> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().to_string())
            .collect();
        for key in CLEARED_VARS {
            assert!(cleared.contains(&key.to_string()), "{key} must be cleared");
        }
    }

    #[test]
    fn log_tail_keeps_only_the_most_recent_lines() {
        let mut tail = LogTail::default();
        assert!(tail.is_empty());
        for i in 0..(LOG_TAIL_LINES + 10) {
            tail.push(format!("line {i}"));
        }
        assert_eq!(tail.len(), LOG_TAIL_LINES);
        let text = tail.text();
        assert!(!text.contains("line 0\n"));
        assert!(text.ends_with(&format!("line {}", LOG_TAIL_LINES + 9)));
    }

    #[test]
    fn start_captures_output_and_reports_exit() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("echo hello; echo oops >&2")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut sidecar = Sidecar::start(command).expect("spawn");
        let deadline = Instant::now() + Duration::from_secs(5);
        while sidecar.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!sidecar.is_running(), "the script must have exited");
        // Give the drain threads a moment after process exit.
        thread::sleep(Duration::from_millis(100));
        let log = sidecar.log_text();
        assert!(log.contains("hello"), "stdout captured: {log:?}");
        assert!(log.contains("oops"), "stderr captured: {log:?}");
        assert!(!sidecar.shutdown(Duration::from_millis(100)), "already exited");
    }

    #[test]
    fn the_real_command_ties_the_child_to_this_process() {
        // build_command must arm PR_SET_PDEATHSIG itself: a shell killed with a
        // signal never reaches its exit handler, and only the kernel can stop the
        // server from outliving it. Proven by spawning the real command shape
        // (with /bin/sh standing in for node) and observing the pre_exec hook did
        // not break the spawn.
        let layout = Layout {
            node: PathBuf::from("/bin/sh"),
            payload_dir: PathBuf::from("/"),
        };
        let mut command = build_command(&layout, 3000, Path::new("/tmp/libredb-test.db"));
        command.arg("--version");
        let mut sidecar = Sidecar::start(command).expect("spawn");
        let deadline = Instant::now() + Duration::from_secs(5);
        while sidecar.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!sidecar.is_running());
    }

    #[test]
    fn shutdown_terminates_a_long_running_child() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 120")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        attach_parent_death_signal(&mut command);
        let mut sidecar = Sidecar::start(command).expect("spawn");
        assert!(sidecar.is_running());
        assert!(sidecar.shutdown(SHUTDOWN_GRACE));
        assert!(!sidecar.is_running());
    }

    #[test]
    fn shutdown_kills_a_child_that_ignores_sigterm() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("trap '' TERM; sleep 120")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut sidecar = Sidecar::start(command).expect("spawn");
        assert!(sidecar.is_running());
        // Short grace so the test exercises the SIGKILL fallback quickly.
        assert!(sidecar.shutdown(Duration::from_millis(300)));
        assert!(!sidecar.is_running());
    }
}
