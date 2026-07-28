//! Where the shell finds the two things it ships: the pinned Node runtime and
//! the standalone server payload.
//!
//! The same binary has to work in four layouts - `cargo tauri dev`, the
//! AppImage AppDir, an installed .deb tree, and the Flatpak repack of the
//! AppImage - and Tauri's own resource directory rules differ between them. So
//! resolution is a candidate list probed in order rather than one hardcoded
//! path, and a failure reports every path that was tried.

use std::fmt;
use std::path::{Path, PathBuf};

/// File that must exist inside a payload directory for it to be a payload
/// (Next.js standalone entry point).
pub const SERVER_ENTRY: &str = "server.js";

/// Resolved on-disk locations of the sidecar's two halves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// The bundled `node` executable.
    pub node: PathBuf,
    /// Payload root - the working directory `node server.js` runs in.
    pub payload_dir: PathBuf,
}

impl Layout {
    /// Absolute path of the server entry point.
    pub fn server_entry(&self) -> PathBuf {
        self.payload_dir.join(SERVER_ENTRY)
    }
}

/// Nothing usable was found; carries the probed candidates for the error dialog.
#[derive(Debug, PartialEq, Eq)]
pub struct MissingPiece {
    pub what: &'static str,
    pub tried: Vec<PathBuf>,
}

impl fmt::Display for MissingPiece {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "could not locate the bundled {} - tried:", self.what)?;
        for path in &self.tried {
            write!(f, "\n  {}", path.display())?;
        }
        Ok(())
    }
}

/// Candidate paths for the bundled Node runtime.
///
/// Tauri strips the target triple from `bundle.externalBin` entries when it
/// installs them next to the app binary, so the bundled name is plain `node`
/// while the checked-in file keeps its triple suffix for `tauri dev`.
pub fn node_candidates(exe_dir: &Path, resource_dir: &Path, target_triple: &str) -> Vec<PathBuf> {
    vec![
        exe_dir.join("node"),
        exe_dir.join(format!("node-{target_triple}")),
        resource_dir.join("node"),
        resource_dir.join("bin").join("node"),
        exe_dir.join("bin").join(format!("node-{target_triple}")),
    ]
}

/// Candidate paths for the standalone server payload directory.
pub fn payload_candidates(exe_dir: &Path, resource_dir: &Path) -> Vec<PathBuf> {
    vec![
        resource_dir.join("payload"),
        exe_dir.join("payload"),
        // `cargo tauri dev` runs from src-tauri/target/<profile>/.
        exe_dir.join("..").join("..").join("payload"),
    ]
}

fn first_existing(candidates: &[PathBuf], is_present: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|candidate| is_present(candidate)).cloned()
}

/// Resolve both halves, treating a payload directory without `server.js` as
/// absent - a stale or half-extracted directory must not shadow a good one.
pub fn resolve_with(
    exe_dir: &Path,
    resource_dir: &Path,
    target_triple: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<Layout, MissingPiece> {
    let node_tried = node_candidates(exe_dir, resource_dir, target_triple);
    let node = first_existing(&node_tried, exists).ok_or(MissingPiece {
        what: "Node.js runtime",
        tried: node_tried,
    })?;

    let payload_tried = payload_candidates(exe_dir, resource_dir);
    let payload_dir = first_existing(&payload_tried, &|dir: &Path| exists(&dir.join(SERVER_ENTRY))).ok_or(
        MissingPiece {
            what: "server payload",
            tried: payload_tried,
        },
    )?;

    Ok(Layout { node, payload_dir })
}

/// [`resolve_with`] against the real filesystem.
pub fn resolve(exe_dir: &Path, resource_dir: &Path, target_triple: &str) -> Result<Layout, MissingPiece> {
    resolve_with(exe_dir, resource_dir, target_triple, &|path: &Path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIPLE: &str = "x86_64-unknown-linux-gnu";

    fn fake_exists<'a>(present: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |path: &Path| present.iter().any(|p| Path::new(p) == path)
    }

    #[test]
    fn resolves_the_bundled_appimage_layout() {
        let exe_dir = Path::new("/tmp/.mount_x/usr/bin");
        let resource_dir = Path::new("/tmp/.mount_x/usr/lib/libredb-studio-desktop");
        let layout = resolve_with(
            exe_dir,
            resource_dir,
            TRIPLE,
            &fake_exists(&[
                "/tmp/.mount_x/usr/bin/node",
                "/tmp/.mount_x/usr/lib/libredb-studio-desktop/payload/server.js",
            ]),
        )
        .expect("layout");
        assert_eq!(layout.node, exe_dir.join("node"));
        assert_eq!(layout.payload_dir, resource_dir.join("payload"));
        assert_eq!(layout.server_entry(), resource_dir.join("payload").join("server.js"));
    }

    #[test]
    fn resolves_the_dev_layout_with_the_triple_suffixed_binary() {
        let exe_dir = Path::new("/repo/desktop/src-tauri/target/debug");
        let resource_dir = Path::new("/repo/desktop/src-tauri/target/debug");
        let layout = resolve_with(
            exe_dir,
            resource_dir,
            TRIPLE,
            &fake_exists(&[
                "/repo/desktop/src-tauri/target/debug/node-x86_64-unknown-linux-gnu",
                "/repo/desktop/src-tauri/target/debug/../../payload/server.js",
            ]),
        )
        .expect("layout");
        assert_eq!(layout.node, exe_dir.join("node-x86_64-unknown-linux-gnu"));
        assert_eq!(layout.payload_dir, exe_dir.join("..").join("..").join("payload"));
    }

    #[test]
    fn a_payload_directory_without_server_js_does_not_count() {
        let exe_dir = Path::new("/app/bin");
        let resource_dir = Path::new("/app/lib");
        // resource_dir/payload exists but is empty; exe_dir/payload is complete.
        let err = resolve_with(
            exe_dir,
            resource_dir,
            TRIPLE,
            &fake_exists(&["/app/bin/node", "/app/lib/payload"]),
        )
        .expect_err("must reject an empty payload dir");
        assert_eq!(err.what, "server payload");

        let layout = resolve_with(
            exe_dir,
            resource_dir,
            TRIPLE,
            &fake_exists(&["/app/bin/node", "/app/lib/payload", "/app/bin/payload/server.js"]),
        )
        .expect("layout");
        assert_eq!(layout.payload_dir, exe_dir.join("payload"));
    }

    #[test]
    fn a_missing_node_runtime_reports_every_probed_path() {
        let err = resolve_with(Path::new("/app/bin"), Path::new("/app/lib"), TRIPLE, &fake_exists(&[]))
            .expect_err("must fail");
        assert_eq!(err.what, "Node.js runtime");
        assert_eq!(err.tried.len(), 5);
        let rendered = err.to_string();
        assert!(rendered.contains("could not locate the bundled Node.js runtime"));
        assert!(rendered.contains("/app/bin/node-x86_64-unknown-linux-gnu"));
    }

    #[test]
    fn resolve_probes_the_real_filesystem() {
        // A path that cannot exist proves resolve() wires exists() through.
        let err = resolve(Path::new("/nonexistent-libredb-exe"), Path::new("/nonexistent-libredb-res"), TRIPLE)
            .expect_err("must fail");
        assert_eq!(err.what, "Node.js runtime");
    }
}
