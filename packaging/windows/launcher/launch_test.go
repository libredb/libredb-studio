// Unit tests for the pure launcher helpers (launch.go). Host-agnostic:
// expectations are built with filepath.Join, so `go test ./...` passes on
// linux CI runners and on Windows alike.
package main

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestResolveLaunchPaths(t *testing.T) {
	paths := resolveLaunchPaths(filepath.Join("C:", "pkg"))
	if want := filepath.Join("C:", "pkg", "node", "node.exe"); paths.Node != want {
		t.Errorf("Node = %q, want %q", paths.Node, want)
	}
	if want := filepath.Join("C:", "pkg", "server.js"); paths.Server != want {
		t.Errorf("Server = %q, want %q", paths.Server, want)
	}
}

func TestEnvValueIsCaseInsensitive(t *testing.T) {
	environ := []string{"storage_sqlite_path=D:\\data\\s.db", "FOO=bar"}
	value, ok := envValue(environ, "STORAGE_SQLITE_PATH")
	if !ok || value != "D:\\data\\s.db" {
		t.Errorf("envValue = %q, %v; want the case-insensitive match", value, ok)
	}
	if _, ok := envValue(environ, "MISSING"); ok {
		t.Error("envValue found a key that is not set")
	}
	// A bare "=..." entry (cmd.exe drive-cwd entries look like "=C:=...")
	// must never match.
	if _, ok := envValue([]string{"=C:=C:\\x"}, ""); ok {
		t.Error("envValue matched an empty key")
	}
	// Duplicate keys: the LAST entry wins, matching os/exec's rule.
	if value, _ := envValue([]string{"FOO=first", "FOO=second"}, "FOO"); value != "second" {
		t.Errorf("envValue duplicate = %q, want the last entry", value)
	}
}

func TestLauncherEnvBindsLoopbackByDefault(t *testing.T) {
	env := launcherEnv([]string{"HOSTNAME=container-1234", "LOCALAPPDATA=" + filepath.Join("C:", "Users", "u", "AppData", "Local")})
	// The override is appended AFTER the inherited entries, so it wins the
	// os/exec last-duplicate-wins rule.
	last := lastValue(t, env, "HOSTNAME")
	if last != "127.0.0.1" {
		t.Errorf("HOSTNAME override = %q, want 127.0.0.1 (an inherited HOSTNAME must never leak into the bind address)", last)
	}
}

func TestLauncherEnvHonoursLibredbBind(t *testing.T) {
	env := launcherEnv([]string{"LIBREDB_BIND=0.0.0.0"})
	if last := lastValue(t, env, "HOSTNAME"); last != "0.0.0.0" {
		t.Errorf("HOSTNAME = %q, want the LIBREDB_BIND opt-in 0.0.0.0", last)
	}
}

func TestLauncherEnvDefaultsStorageUnderLocalAppData(t *testing.T) {
	localAppData := filepath.Join("C:", "Users", "u", "AppData", "Local")
	env := launcherEnv([]string{"LOCALAPPDATA=" + localAppData})
	want := filepath.Join(localAppData, "LibreDB", "Studio", "libredb-storage.db")
	if last := lastValue(t, env, "STORAGE_SQLITE_PATH"); last != want {
		t.Errorf("STORAGE_SQLITE_PATH = %q, want %q", last, want)
	}
}

func TestLauncherEnvKeepsPresetStoragePath(t *testing.T) {
	env := launcherEnv([]string{"STORAGE_SQLITE_PATH=D:\\custom\\s.db", "LOCALAPPDATA=C:\\lad"})
	if count := countKey(env, "STORAGE_SQLITE_PATH"); count != 1 {
		t.Errorf("STORAGE_SQLITE_PATH appears %d times, want the single preset entry", count)
	}
}

func TestLauncherEnvTreatsEmptyPresetsAsUnset(t *testing.T) {
	// Parity with packaging/linux/libredb-studio's ${VAR:-} handling: an
	// inherited-but-empty value must not suppress the zero-config defaults
	// (the server would fall back to ./data inside the install tree).
	localAppData := filepath.Join("C:", "Users", "u", "AppData", "Local")
	env := launcherEnv([]string{"STORAGE_SQLITE_PATH=", "NODE_ENV=", "LOCALAPPDATA=" + localAppData})
	wantStorage := filepath.Join(localAppData, "LibreDB", "Studio", "libredb-storage.db")
	if last := lastValue(t, env, "STORAGE_SQLITE_PATH"); last != wantStorage {
		t.Errorf("STORAGE_SQLITE_PATH = %q, want the default %q despite the empty preset", last, wantStorage)
	}
	if last := lastValue(t, env, "NODE_ENV"); last != "production" {
		t.Errorf("NODE_ENV = %q, want production despite the empty preset", last)
	}
}

func TestLauncherEnvFallsBackToUserProfile(t *testing.T) {
	profile := filepath.Join("C:", "Users", "u")
	env := launcherEnv([]string{"USERPROFILE=" + profile})
	want := filepath.Join(profile, "AppData", "Local", "LibreDB", "Studio", "libredb-storage.db")
	if last := lastValue(t, env, "STORAGE_SQLITE_PATH"); last != want {
		t.Errorf("STORAGE_SQLITE_PATH = %q, want the USERPROFILE-derived %q", last, want)
	}
}

func TestLauncherEnvSkipsStorageWhenUnresolvable(t *testing.T) {
	env := launcherEnv([]string{"PATH=x"})
	if count := countKey(env, "STORAGE_SQLITE_PATH"); count != 0 {
		t.Error("STORAGE_SQLITE_PATH must stay unset when no LOCALAPPDATA/USERPROFILE exists (server falls back to ./data)")
	}
}

func TestLauncherEnvDefaultsNodeEnv(t *testing.T) {
	if last := lastValue(t, launcherEnv(nil), "NODE_ENV"); last != "production" {
		t.Errorf("NODE_ENV = %q, want production", last)
	}
	env := launcherEnv([]string{"NODE_ENV=development"})
	if count := countKey(env, "NODE_ENV"); count != 1 {
		t.Error("a preset NODE_ENV must not be overridden")
	}
}

func TestLauncherEnvPreservesInheritedEntries(t *testing.T) {
	env := launcherEnv([]string{"JWT_SECRET=abc", "PORT=3900"})
	if !slices.Contains(env, "JWT_SECRET=abc") || !slices.Contains(env, "PORT=3900") {
		t.Error("inherited environment entries must pass through untouched")
	}
}

func TestDefaultStoragePathEmptyInput(t *testing.T) {
	if got := defaultStoragePath(""); got != "" {
		t.Errorf("defaultStoragePath(\"\") = %q, want \"\"", got)
	}
}

// lastValue returns the value of the LAST entry for key - the one os/exec
// hands to the child under its duplicate-key rule.
func lastValue(t *testing.T, environ []string, key string) string {
	t.Helper()
	value := ""
	found := false
	for _, entry := range environ {
		if len(entry) > len(key)+1 && entry[:len(key)] == key && entry[len(key)] == '=' {
			value = entry[len(key)+1:]
			found = true
		}
	}
	if !found {
		t.Fatalf("no %s entry in %v", key, environ)
	}
	return value
}

func countKey(environ []string, key string) int {
	count := 0
	for _, entry := range environ {
		if len(entry) > len(key)+1 && entry[:len(key)] == key && entry[len(key)] == '=' {
			count++
		}
	}
	return count
}
