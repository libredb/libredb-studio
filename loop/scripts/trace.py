#!/usr/bin/env python3
"""Live, compact trace of the running loop iteration.

WHY THIS EXISTS. `claude -p` buffers: nothing reaches
`.loop/logs/iteration-N.log` until the process exits, so a healthy iteration and
a wedged one look identical for up to `LOOP_ITERATION_TIMEOUT`. Claude Code does
write every session's event stream to `~/.claude/projects/<slug>/<uuid>.jsonl`
unbuffered as it happens, so that file - not the runner's log - is where a
running iteration is observable.

WHY IT READS A FILE INSTEAD OF THE AGENT'S STDOUT. The obvious alternative is
`--output-format stream-json` piped into a formatter. `loop.sh` deliberately
redirects the agent to a FILE and not through a pipe (see its comment at the
`run_agent` call): a pipe stays open while ANY surviving child of a killed agent
holds it, which wedges the runner long after `timeout(1)` fired. Reading the
transcript keeps the runner's IO untouched, needs no restart, and works
retroactively on an iteration that is already in flight.

Each iteration is a new session and therefore a new transcript. This polls for
the newest one whose first line carries a loop iteration prompt, follows it, and
switches when the next iteration starts - so it can be left running overnight.

Usage:
    python3 loop/scripts/trace.py            # follow, print to stdout
    python3 loop/scripts/trace.py --log      # also append to .loop/logs/trace.log
    nohup python3 loop/scripts/trace.py --log >/dev/null 2>&1 &   # unattended
    tail -f .loop/logs/trace.log             # then just watch the file
"""

import json
import os
import sys
import time
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Claude Code names a project directory after its cwd with "/" replaced by "-".
# Deriving it keeps this script portable across checkouts and machines; the
# fallback covers a slug rule that does not match that assumption.
PROJECTS_ROOT = os.environ.get(
    "CLAUDE_PROJECTS_ROOT", os.path.expanduser("~/.claude/projects")
)

# Line 1 of a loop transcript carries the iteration prompt; a human's own
# interactive session in the same repo does not. This is the only thing
# separating the loop's transcript from the operator's.
MARKER = "maintainer loop"
WIDTH = 150

sinks = [sys.stdout]
if "--log" in sys.argv:
    logdir = os.path.join(REPO_ROOT, ".loop", "logs")
    os.makedirs(logdir, exist_ok=True)
    sinks.append(open(os.path.join(logdir, "trace.log"), "a", buffering=1))


def emit(line):
    for sink in sinks:
        try:
            sink.write(line + "\n")
            sink.flush()
        except (BrokenPipeError, ValueError):
            pass


def project_dir():
    """The Claude Code project directory for this repository."""
    derived = os.path.join(PROJECTS_ROOT, REPO_ROOT.replace("/", "-"))
    if os.path.isdir(derived):
        return derived
    # Fallback: the newest directory whose name ends with this repo's basename.
    base = os.path.basename(REPO_ROOT)
    try:
        candidates = [
            os.path.join(PROJECTS_ROOT, name)
            for name in os.listdir(PROJECTS_ROOT)
            if name.endswith(base) and os.path.isdir(os.path.join(PROJECTS_ROOT, name))
        ]
    except OSError:
        return None
    return max(candidates, key=os.path.getmtime) if candidates else None


def clip(text, width=WIDTH):
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[: width - 1] + "…"


def find_transcript():
    """Newest .jsonl in this project whose first line looks like a loop iteration."""
    root = project_dir()
    if not root:
        return None
    best, best_mtime = None, 0
    try:
        names = os.listdir(root)
    except OSError:
        return None
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(root, name)
        try:
            mtime = os.path.getmtime(path)
            if mtime <= best_mtime:
                continue
            with open(path, "r", errors="replace") as handle:
                head = handle.readline(20000)
        except OSError:
            continue
        if MARKER in head:
            best, best_mtime = path, mtime
    return best


def event_time(entry):
    """The record's OWN time, not now: replaying a backlog must not stamp every
    line with the moment it was read. Transcript timestamps are UTC ISO-8601."""
    raw = entry.get("timestamp")
    if isinstance(raw, str):
        try:
            when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return when.astimezone().strftime("%H:%M:%S")
        except ValueError:
            pass
    return datetime.now().strftime("%H:%M:%S")


def describe_tool(name, inp):
    """One short line naming what the agent is actually doing."""
    if not isinstance(inp, dict):
        return name, clip(inp)
    for key in ("command", "file_path", "pattern", "query", "path", "prompt", "url"):
        if key in inp:
            detail = inp[key]
            if key == "prompt":  # subagent dispatch: the first line is the ask
                text = str(detail).strip()
                detail = text.splitlines()[0] if text else ""
            return name, clip(detail)
    return name, clip(json.dumps(inp))


def render(entry):
    """Yield zero or more (label, detail) display pairs for one record."""
    message = entry.get("message")
    if not isinstance(message, dict):
        return
    content = message.get("content")
    if isinstance(content, str):
        if content.strip():
            yield ("SAY", clip(content))
        return
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            if block.get("text", "").strip():
                yield ("SAY", clip(block["text"]))
        elif btype == "thinking":
            thought = block.get("thinking", "").strip()
            if thought:
                yield ("think", clip(thought, 100))
        elif btype == "tool_use":
            name, detail = describe_tool(block.get("name", "?"), block.get("input"))
            yield ("TOOL " + name, detail)
        elif btype == "tool_result":
            body = block.get("content")
            if isinstance(body, list):
                body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
            body = str(body or "")
            nlines = body.count("\n") + 1 if body else 0
            label = "  err" if block.get("is_error") else "  ->"
            head = clip(body, WIDTH - 12) if body else "(empty)"
            yield (label, "[%d lines] %s" % (nlines, head) if nlines > 1 else head)


def main():
    current, offset = None, 0
    emit("== loop trace started %s ==" % datetime.now().strftime("%H:%M:%S"))
    while True:
        found = find_transcript()
        if found and found != current:
            current, offset = found, 0
            emit(
                "\n== iteration transcript: %s (%s) =="
                % (os.path.basename(found), datetime.now().strftime("%H:%M:%S"))
            )
        if not current:
            time.sleep(3)
            continue
        try:
            with open(current, "r", errors="replace") as handle:
                handle.seek(offset)
                for line in handle:
                    if not line.endswith("\n"):  # partial write; retry next pass
                        break
                    offset += len(line.encode("utf-8", "replace"))
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    stamp = event_time(entry)
                    for label, detail in render(entry):
                        emit("%s %-14s %s" % (stamp, label, detail))
        except OSError:
            pass
        time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit("== loop trace stopped ==")
