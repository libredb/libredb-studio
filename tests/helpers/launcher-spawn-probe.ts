/**
 * A Node.js preload for the two launchers that spawn Studio's server, scripts/next-with-seed-assets.mjs (`bun dev`,
 * `bun start`) and bin/studio.js (npx), so a test learns what held at the moment the launcher spawned the server
 * instead of relying on how the launcher and the server it starts are scheduled.
 *
 * Passed to `node --import`, it wraps child_process.spawn. At each call it records how many SIGINT and SIGTERM
 * listeners the launcher has; with `signal` set, it then sends that signal to the launcher itself, before the real
 * spawn runs, as one that reaches the launcher while the server does not exist yet; and it records how the spawned
 * process ended, from an exit listener added before the launcher's own, so the record is written before the launcher
 * acts on that end.
 *
 * With `signal` and `before` set, it sends the signal earlier instead: at the launcher's first fs.existsSync or
 * fs.readFileSync of a path whose base name is `before`, a step the launcher takes before it spawns anything.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** The SIGINT and SIGTERM listener counts the launcher had when it called spawn. */
export interface ListenersAtSpawn {
  readonly SIGINT: number;
  readonly SIGTERM: number;
}

export interface SpawnProbe {
  /** The value for `node --import`: a file: URL, which Windows needs, since an absolute path there parses as a URL. */
  readonly importUrl: string;
  /** The listener counts at the spawn, or null when the launcher never called spawn. */
  listenersAtSpawn(): ListenersAtSpawn | null;
  /** How the spawned process ended, as Node.js reports it, [code, signal], or null when the launcher never saw it. */
  childEnd(): [number | null, string | null] | null;
}

/** `before` names a pre-spawn step to send `signal` at, so it is given only together with a signal. */
export type SpawnProbeOptions =
  | { readonly signal?: "SIGINT" | "SIGTERM"; readonly before?: never }
  | { readonly signal: "SIGINT" | "SIGTERM"; readonly before: string };

function readJson<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
}

/** Writes the preload into `directory`, which keeps its records too. */
export function spawnProbe(directory: string, { signal, before }: SpawnProbeOptions = {}): SpawnProbe {
  const atSpawn = path.join(directory, "listeners-at-spawn.json");
  const end = path.join(directory, "child-end.json");
  const preload = path.join(directory, "spawn-probe.mjs");
  fs.writeFileSync(
    preload,
    [
      'import childProcess from "node:child_process";',
      'import fs, { writeFileSync } from "node:fs";',
      'import { basename } from "node:path";',
      'import { syncBuiltinESMExports } from "node:module";',
      ...(before === undefined
        ? []
        : [
            "let signalled = false;",
            'for (const name of ["existsSync", "readFileSync"]) {',
            "  const original = fs[name];",
            "  fs[name] = function (file, ...rest) {",
            `    if (!signalled && typeof file === "string" && basename(file) === ${JSON.stringify(before)}) {`,
            "      signalled = true;",
            `      process.kill(process.pid, ${JSON.stringify(signal)});`,
            "    }",
            "    return original.call(this, file, ...rest);",
            "  };",
            "}",
          ]),
      "const spawn = childProcess.spawn;",
      "childProcess.spawn = function (...args) {",
      `  writeFileSync(${JSON.stringify(atSpawn)}, JSON.stringify({ SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }));`,
      ...(signal === undefined || before !== undefined
        ? []
        : [`  process.kill(process.pid, ${JSON.stringify(signal)});`]),
      "  const child = spawn.apply(this, args);",
      `  child.on("exit", (code, signal) => writeFileSync(${JSON.stringify(end)}, JSON.stringify([code, signal])));`,
      "  return child;",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return {
    importUrl: pathToFileURL(preload).href,
    listenersAtSpawn: () => readJson<ListenersAtSpawn>(atSpawn),
    childEnd: () => readJson<[number | null, string | null]>(end),
  };
}

/** Reads `stream` until it has printed `text`; throws when the stream ends first. */
export async function untilPrinted(stream: ReadableStream<Uint8Array>, text: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(text)) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after the other.
    const { value, done } = await reader.read();
    if (done) throw new Error(`the stream ended before it printed ${JSON.stringify(text)}: ${seen}`);
    seen += decoder.decode(value);
  }
  reader.releaseLock();
}
