// libredb-studio.exe - the Windows launcher shipped at the root of the
// win32-x64 standalone zip (issue #114), installed by winget (portable) and
// Chocolatey. The win32 sibling of packaging/linux/libredb-studio: it execs
// the bundled private Node runtime against the standalone server payload
// sitting next to the executable, with the same local-first defaults.
//
// Go (CGO_ENABLED=0, cross-compiled from any OS) so Linux/macOS
// contributors can rebuild the shim without a Windows box; see
// packaging/windows/README.md.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
)

func main() {
	exe, err := os.Executable()
	if err != nil {
		fatal(fmt.Sprintf("could not resolve the launcher path: %v", err))
	}
	// winget's portable install exposes the exe through an NTFS symlink in
	// its Links folder; the payload (node/, server.js) sits next to the REAL
	// binary. EvalSymlinks is a no-op when there is no symlink, so resolve
	// unconditionally.
	if resolved, evalErr := filepath.EvalSymlinks(exe); evalErr == nil {
		exe = resolved
	}
	exeDir := filepath.Dir(exe)

	paths := resolveLaunchPaths(exeDir)
	for _, required := range []string{paths.Node, paths.Server} {
		if _, statErr := os.Stat(required); statErr != nil {
			fatal(fmt.Sprintf(
				"%s not found - libredb-studio.exe must stay at the root of the extracted LibreDB Studio zip (next to node\\ and server.js)",
				required,
			))
		}
	}

	env := launcherEnv(os.Environ())
	// The default storage path's parent directories may not exist yet
	// (fresh %LOCALAPPDATA%); the server expects the directory to be there
	// (the deb/Homebrew packages pre-create theirs the same way). An empty
	// preset counts as unset, mirroring launcherEnv.
	if value, preset := envValue(os.Environ(), "STORAGE_SQLITE_PATH"); !preset || value == "" {
		if storage, ok := envValue(env, "STORAGE_SQLITE_PATH"); ok {
			if mkdirErr := os.MkdirAll(filepath.Dir(storage), 0o755); mkdirErr != nil {
				fatal(fmt.Sprintf("could not create the storage directory for %s: %v", storage, mkdirErr))
			}
		}
	}

	cmd := exec.Command(paths.Node, append([]string{paths.Server}, os.Args[1:]...)...)
	cmd.Dir = exeDir
	cmd.Env = env
	// os/exec defaults nil stdio to the null device, NOT the parent console.
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr

	// Ctrl+C / Ctrl+Break reach the child directly (same console process
	// group); the launcher only has to outlive it to report the real exit
	// code instead of dying to its own default interrupt handling. os/signal
	// documents this suppression explicitly for Notify on Windows ("the
	// program will not exit"), so Notify-and-drain is the doc-sanctioned
	// form; the channel must be buffered (Notify sends non-blocking).
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	go func() {
		for range interrupts {
		}
	}()

	if runErr := cmd.Run(); runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			os.Exit(exitErr.ProcessState.ExitCode())
		}
		fatal(fmt.Sprintf("could not start %s: %v", paths.Node, runErr))
	}
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, "libredb-studio launcher: "+message)
	os.Exit(1)
}
