//! Loopback networking helpers: free-port selection and the boot health gate.
//!
//! The desktop shell talks to its sidecar over plain HTTP on 127.0.0.1, so a
//! full HTTP client would be dead weight (and, for a bundled app, extra supply
//! chain). A status-line read over `std::net` is enough for the one request the
//! shell ever makes on its own behalf: `GET /api/db/health`.

use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// Health endpoint the standalone server answers without authentication
/// (`src/app/api/db/health/route.ts`, allow-listed in `src/proxy.ts`).
pub const HEALTH_PATH: &str = "/api/db/health";

/// Ask the OS for an unused loopback port, then release it.
///
/// The close-then-spawn window is a race in theory; on a desktop machine it is
/// not worth a lock file. Callers retry with a fresh port when the sidecar dies
/// with `EADDRINUSE` (see [`crate::backoff`]).
pub fn pick_free_port() -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Parse the status code out of an HTTP/1.x status line.
pub fn parse_status_line(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// Issue one `GET <path>` against 127.0.0.1:<port> and return the status code.
pub fn http_status(port: u16, path: &str, timeout: Duration) -> io::Result<u16> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    // Formatted first, then written once. `write!` on a TcpStream emits one
    // write() syscall per format fragment, so the request leaves in pieces: a
    // peer that answers and closes after reading only the first piece resets the
    // connection, and the later pieces then fail with EPIPE before this function
    // ever gets to read the status line.
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n");
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    parse_status_line(&line).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("bad status line: {line:?}")))
}

/// Why the boot gate stopped waiting.
#[derive(Debug, PartialEq, Eq)]
pub enum HealthOutcome {
    /// `/api/db/health` answered 200 - the server is serving.
    Healthy,
    /// The sidecar process exited before it became healthy.
    Exited,
    /// The deadline passed while the process was still running.
    Timeout,
}

/// Poll the health endpoint until it answers 200, the child dies, or the
/// deadline passes.
///
/// `child_alive` and `sleep` are injected so the policy is unit-testable
/// without spawning a real server or waiting real seconds.
pub fn wait_for_health<A, S>(
    port: u16,
    deadline: Duration,
    interval: Duration,
    mut child_alive: A,
    mut sleep: S,
) -> HealthOutcome
where
    A: FnMut() -> bool,
    S: FnMut(Duration),
{
    let started = Instant::now();
    loop {
        if !child_alive() {
            return HealthOutcome::Exited;
        }
        if matches!(http_status(port, HEALTH_PATH, interval), Ok(200)) {
            return HealthOutcome::Healthy;
        }
        if started.elapsed() >= deadline {
            return HealthOutcome::Timeout;
        }
        sleep(interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;

    /// Read request lines until the blank line that ends the headers.
    ///
    /// A double that answers after a partial read closes with request bytes still
    /// queued, and the kernel resets such a connection instead of finishing it.
    /// The client then fails on a write or a read rather than parsing the status
    /// line it was handed - which is how these tests used to fail on arm64 while
    /// passing on x86_64, purely on scheduling luck.
    fn drain_request(stream: &TcpStream) {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        while let Ok(read) = reader.read_line(&mut line) {
            if read == 0 || line == "\r\n" || line == "\n" {
                return;
            }
            line.clear();
        }
    }

    /// Serve `count` requests with the given status line, then stop.
    fn serve(status: &'static str, count: usize) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            for _ in 0..count {
                let Ok((mut stream, _)) = listener.accept() else { return };
                drain_request(&stream);
                let _ = stream.write_all(format!("{status}\r\nContent-Length: 0\r\n\r\n").as_bytes());
            }
        });
        (port, handle)
    }

    #[test]
    fn pick_free_port_returns_a_bindable_port() {
        let port = pick_free_port().expect("pick");
        assert!(port > 0);
        // Released again, so it must be bindable right after.
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("rebind");
    }

    #[test]
    fn pick_free_port_does_not_repeat_while_held() {
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let held_port = held.local_addr().expect("addr").port();
        assert_ne!(pick_free_port().expect("pick"), held_port);
    }

    #[test]
    fn parse_status_line_reads_the_code() {
        assert_eq!(parse_status_line("HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_line("HTTP/1.0 503 Service Unavailable\r\n"), Some(503));
        assert_eq!(parse_status_line(""), None);
        assert_eq!(parse_status_line("GARBAGE 200 OK"), None);
        assert_eq!(parse_status_line("HTTP/1.1 abc OK"), None);
        assert_eq!(parse_status_line("HTTP/1.1"), None);
    }

    #[test]
    fn http_status_reads_a_served_response() {
        let (port, handle) = serve("HTTP/1.1 200 OK", 1);
        assert_eq!(http_status(port, HEALTH_PATH, Duration::from_secs(2)).ok(), Some(200));
        handle.join().expect("join");
    }

    #[test]
    fn http_status_errors_when_nothing_listens() {
        let port = pick_free_port().expect("pick");
        assert!(http_status(port, HEALTH_PATH, Duration::from_millis(200)).is_err());
    }

    /// The server must receive a complete, well-formed request: the blank line
    /// that ends the headers is what tells a real server to start answering.
    /// Read to that terminator rather than counting bytes or reads - TCP is free
    /// to split a write, and asserting otherwise is how a test starts flaking.
    #[test]
    fn http_status_sends_a_complete_request() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = String::new();
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut line = String::new();
            while reader.read_line(&mut line).expect("read") > 0 {
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
                line.clear();
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            request
        });
        assert_eq!(http_status(port, HEALTH_PATH, Duration::from_secs(2)).ok(), Some(200));
        let request = handle.join().expect("join");
        assert_eq!(
            request,
            format!("GET /api/db/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n")
        );
    }

    /// A peer that hangs up without answering must surface as an error, and the
    /// assertion deliberately does not pin the `ErrorKind`: whether the loser of
    /// that race sees `ConnectionReset`, `BrokenPipe` or `UnexpectedEof` depends
    /// on scheduling, and pinning it is what made these tests flake.
    #[test]
    fn http_status_errors_when_the_peer_hangs_up_without_answering() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else { return };
            drop(stream);
        });
        assert!(http_status(port, HEALTH_PATH, Duration::from_secs(2)).is_err());
        handle.join().expect("join");
    }

    #[test]
    fn http_status_rejects_a_non_http_greeting() {
        let (port, handle) = serve("SSH-2.0-OpenSSH", 1);
        let err = http_status(port, HEALTH_PATH, Duration::from_secs(2)).expect_err("must reject");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        handle.join().expect("join");
    }

    #[test]
    fn wait_for_health_returns_healthy_once_the_server_answers() {
        let (port, handle) = serve("HTTP/1.1 200 OK", 1);
        let outcome = wait_for_health(port, Duration::from_secs(2), Duration::from_millis(50), || true, |_| {});
        assert_eq!(outcome, HealthOutcome::Healthy);
        handle.join().expect("join");
    }

    #[test]
    fn wait_for_health_keeps_polling_through_non_200_answers() {
        let (port, handle) = serve("HTTP/1.1 503 Service Unavailable", 2);
        let sleeps = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&sleeps);
        // Deadline expires after the served responses are exhausted.
        let outcome = wait_for_health(port, Duration::from_millis(150), Duration::from_millis(50), || true, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(60));
        });
        assert_eq!(outcome, HealthOutcome::Timeout);
        assert!(sleeps.load(Ordering::SeqCst) >= 2, "must have polled repeatedly");
        handle.join().expect("join");
    }

    #[test]
    fn wait_for_health_reports_a_dead_child_immediately() {
        let port = pick_free_port().expect("pick");
        let outcome = wait_for_health(port, Duration::from_secs(5), Duration::from_millis(10), || false, |_| {
            panic!("must not sleep when the child is gone")
        });
        assert_eq!(outcome, HealthOutcome::Exited);
    }
}
