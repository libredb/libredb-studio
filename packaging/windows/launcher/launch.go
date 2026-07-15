// Pure helpers for the Windows launcher (main.go) - the win32 sibling of
// packaging/linux/libredb-studio. Everything here is host-agnostic (built
// with filepath so the same assertions hold under `go test` on any OS) and
// covered by launch_test.go; main.go stays a thin composition.
package main

import (
	"path/filepath"
	"strings"
)

// launchPaths are the payload files the launcher composes, resolved
// relative to the directory of the real executable (the zip root).
type launchPaths struct {
	Node   string // bundled private runtime: <exeDir>/node/node.exe
	Server string // standalone Next.js server: <exeDir>/server.js
}

// resolveLaunchPaths maps the launcher's directory to the payload layout
// packed by scripts/lib/pack-standalone-zip.sh (flat zip, issue #114).
func resolveLaunchPaths(exeDir string) launchPaths {
	return launchPaths{
		Node:   filepath.Join(exeDir, "node", "node.exe"),
		Server: filepath.Join(exeDir, "server.js"),
	}
}

// envValue looks up a key in a "key=value" environ slice and returns the
// LAST match - the value os/exec hands to the child under its
// duplicate-key rule. Windows environment keys are case-insensitive, so
// the match is too - a user's `set storage_sqlite_path=...` must count as
// "already set".
func envValue(environ []string, key string) (string, bool) {
	value, found := "", false
	for _, entry := range environ {
		if eq := strings.IndexByte(entry, '='); eq > 0 && strings.EqualFold(entry[:eq], key) {
			value, found = entry[eq+1:], true
		}
	}
	return value, found
}

// defaultStoragePath is the zero-config server-side SQLite location:
// <localAppData>\LibreDB\Studio\libredb-storage.db. Returns "" when
// localAppData is unknown - the caller then leaves STORAGE_SQLITE_PATH
// unset and the server falls back to its relative ./data default.
func defaultStoragePath(localAppData string) string {
	if localAppData == "" {
		return ""
	}
	return filepath.Join(localAppData, "LibreDB", "Studio", "libredb-storage.db")
}

// resolveLocalAppData returns %LOCALAPPDATA%, falling back to the
// conventional <%USERPROFILE%>\AppData\Local when only USERPROFILE is set
// (os.UserCacheDir has no such fallback and just errors), or "" when
// neither is available.
func resolveLocalAppData(environ []string) string {
	if value, ok := envValue(environ, "LOCALAPPDATA"); ok && value != "" {
		return value
	}
	if profile, ok := envValue(environ, "USERPROFILE"); ok && profile != "" {
		return filepath.Join(profile, "AppData", "Local")
	}
	return ""
}

// launcherEnv builds the child environment. Appended entries win over
// inherited duplicates (os/exec: "only the last value in the slice for each
// duplicate key is used", case-insensitively deduped on Windows):
//   - HOSTNAME is ALWAYS overridden to LIBREDB_BIND or loopback - the
//     local-first bind contract of packaging/linux/libredb-studio (issue
//     #134): an inherited HOSTNAME (e.g. a container hostname) must never
//     silently become the server's bind address.
//   - STORAGE_SQLITE_PATH defaults under LOCALAPPDATA when unset, so the
//     zero-config first run can persist generated credentials outside the
//     (potentially read-only or replaced-on-upgrade) install directory.
//   - NODE_ENV defaults to production (parity with the npx launcher).
func launcherEnv(environ []string) []string {
	env := append([]string(nil), environ...)

	bind := "127.0.0.1"
	if value, ok := envValue(environ, "LIBREDB_BIND"); ok && value != "" {
		bind = value
	}
	env = append(env, "HOSTNAME="+bind)

	// An inherited-but-EMPTY value counts as unset (parity with the Linux
	// wrapper's ${VAR:-} handling): the server treats "" as absent and would
	// otherwise fall back to ./data inside the install tree.
	if value, ok := envValue(environ, "STORAGE_SQLITE_PATH"); !ok || value == "" {
		if storage := defaultStoragePath(resolveLocalAppData(environ)); storage != "" {
			env = append(env, "STORAGE_SQLITE_PATH="+storage)
		}
	}

	if value, ok := envValue(environ, "NODE_ENV"); !ok || value == "" {
		env = append(env, "NODE_ENV=production")
	}
	return env
}
