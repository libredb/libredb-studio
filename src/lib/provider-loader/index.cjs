// The provider loader: the one place LibreDB Studio brings a provider package's code into its process
// (docs/providers/CONTRACT.md, clauses C-87 to C-90; docs/TOOLCHAIN.md, "The provider loader").
//
// `loadPackage` imports a package's entry from the `file:` URL of its absolute path, under a deadline its caller
// passes, and reads only the namespace's `default`. Every outcome but a plain record is a refusal with the code
// `PROVIDER_LOAD_FAILED` and one closed reason: `import-threw`, `deadline-passed`, `default-missing`,
// `interop-wrapper` or `not-a-record`. No step of the check calls the package's code: a Proxy is refused before any of
// its traps could run, and an interop wrapper's inner `default` is never read. The record is answered as the package
// exported it; admission checks and freezes it.
//
// Why plain CommonJS with a hand-written declaration: Next.js leaves this package to Node's `require` (it is listed in
// serverExternalPackages), so it must run as Node finds it in node_modules, with no build step. Why a `file:`
// directory rather than a workspace package: Turbopack bundles a package bun links from a workspace, once per bundle,
// and replaces its `import()` with a stub that throws; a directory under node_modules stays external, so a process
// holds one copy of this module.
//
// The measured runtime limit: Bun unwraps a CommonJS module's interop wrapper (`{ __esModule: true, default }`)
// before the loader reads it, and Node does not, so only an ES module entry reads alike on Node, Electron and Bun.
//
// The deadline cannot stop synchronous code: it is a timer in this thread (C-37). An import that settles after its
// refusal reaches the caller's `onLateSettle` once, without the success's value, so no caller can register a late
// record by accident, and its rejection is always handled here. A port that throws is a host defect: its error is not
// caught and surfaces as an unhandled rejection.
//
// The registry is this module's own Map. Next.js leaves the module to Node's `require`, so Node's module cache gives a
// process one instance and one registry. A record enters it only through `registerAdmitted`, which its caller calls
// once admission passed; `loadPackage` registers nothing. `admitted` lists the records in the order registered, an
// order nothing reads (C-43).
//
// A CommonJS file, so require() is its only import form.
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { types } = require("node:util");

const CODE = "PROVIDER_LOAD_FAILED";
/** The process's admitted records, by package name. */
const registry = new Map();
/** The longest delay a Node timer honours; a longer one fires at once. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** A frozen refusal of `entry` for `reason`. */
function refusal(entry, reason) {
  return Object.freeze({ loaded: false, code: CODE, reason, entry });
}

/** The refusal reason for a namespace whose default is not a plain record, or undefined for one that is. */
function recordRefusalReason(namespace) {
  if (!Object.prototype.hasOwnProperty.call(namespace, "default")) return "default-missing";
  const value = namespace.default;
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) {
    return "not-a-record";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "not-a-record";
  if (Object.prototype.hasOwnProperty.call(value, "__esModule")) return "interop-wrapper";
  return undefined;
}

/** The answer for an import that settled with `namespace` within its deadline. */
function answerFor(entry, namespace) {
  const reason = recordRefusalReason(namespace);
  if (reason !== undefined) return refusal(entry, reason);
  return Object.freeze({ loaded: true, entry, record: namespace.default });
}

/** Throws a TypeError for each host defect in the arguments, before anything is imported. */
function assertArguments(entry, options) {
  if (typeof entry !== "string" || !isAbsolute(entry)) {
    throw new TypeError("loadPackage: entry must be an absolute path");
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("loadPackage: options must be an object");
  }
  const { deadlineMs, onLateSettle } = options;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > LONGEST_TIMER_MS) {
    throw new TypeError(`loadPackage: deadlineMs must be a whole number of milliseconds from 1 to ${LONGEST_TIMER_MS}`);
  }
  if (typeof onLateSettle !== "function") {
    throw new TypeError("loadPackage: onLateSettle must be a function");
  }
}

/**
 * Imports the entry at the absolute path `entry` under `options.deadlineMs` and answers a frozen
 * `{ loaded: true, entry, record }` or a frozen `{ loaded: false, code: "PROVIDER_LOAD_FAILED", reason, entry }`,
 * with `cause`, the thrown value by reference, on `import-threw` only. `cause` is for the host's log; a host never
 * sends it to a client. A host defect in the arguments rejects with a TypeError and imports nothing.
 */
async function loadPackage(entry, options) {
  assertArguments(entry, options);
  const { deadlineMs, onLateSettle } = options;
  return new Promise((resolve) => {
    let answered = false;
    const timer = setTimeout(() => {
      answered = true;
      resolve(refusal(entry, "deadline-passed"));
    }, deadlineMs);
    import(pathToFileURL(entry).href).then(
      (namespace) => {
        if (answered) {
          onLateSettle(Object.freeze({ entry, outcome: "fulfilled" }));
          return;
        }
        answered = true;
        clearTimeout(timer);
        resolve(answerFor(entry, namespace));
      },
      (cause) => {
        if (answered) {
          onLateSettle(Object.freeze({ entry, outcome: "rejected", cause }));
          return;
        }
        answered = true;
        clearTimeout(timer);
        resolve(Object.freeze({ loaded: false, code: CODE, reason: "import-threw", entry, cause }));
      },
    );
  });
}

/** Adds `record` to the registry under `name`; a name registered before is refused, and its first record stays. */
function registerAdmitted(name, record) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("registerAdmitted: name must be a non-empty string");
  }
  if (typeof record !== "object" || record === null) {
    throw new TypeError("registerAdmitted: record must be an object");
  }
  if (registry.has(name)) throw new Error(`registerAdmitted: ${JSON.stringify(name)} is registered already`);
  registry.set(name, record);
}

/** The admitted records, a frozen list of frozen `{ name, record }` in the order registered. */
function admitted() {
  return Object.freeze(Array.from(registry, ([name, record]) => Object.freeze({ name, record })));
}

module.exports = { loadPackage, registerAdmitted, admitted };
