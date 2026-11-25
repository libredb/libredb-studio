/**
 * The trust material: the CA certificates of the file `NODE_EXTRA_CA_CERTS` names, the operator's private CA bundle,
 * read by core once per process for the providers whose TLS library does not read Node.js's trust store.
 *
 * Node.js reads the variable itself when the process starts and adds the file's certificates to every TLS connection
 * it opens without a `ca` of its own, so a provider on `node:tls`, `node:https`, `fetch` or a driver built on them
 * needs nothing from here. A provider whose TLS is a library of its own never sees the variable: measured on
 * 2026-11-22, the one such provider is Db2, whose driver verifies with rustls against the operating system's store.
 * Core owns that read (FND-2, the provider plugins design section 0.1): this module is the only database code that
 * reads the variable or the file, and the provider factory hands the material, as data, to the engines whose
 * `READS_TRUST_MATERIAL` row in `./compatibility` is true; for an engine a provider package serves, the package open
 * context (`@/lib/provider-host/open-context`) hands it to the package's `open` when the engine's declaration reads it.
 *
 * What is read: an unset or empty variable is no certificate, as it is for Node.js. Otherwise the file is read as
 * UTF-8 and refused, with its reason, when it cannot be read, is empty or blank, holds a block under the legacy
 * `-----BEGIN X509 CERTIFICATE-----` label, holds no `-----BEGIN CERTIFICATE-----` block, or holds a block with no
 * `-----END CERTIFICATE-----` line before the next block or the end of the file. A marker counts only on a line of its
 * own, which may end in blanks and a carriage return, so a comment that quotes one is text like any other. A UTF-8
 * byte order mark is ignored where OpenSSL, and so Node.js, ignores it: at the start of the first line each PEM read
 * takes, which is the start of the file and the line right after an END line of any PEM block. A mark anywhere else,
 * such as after a blank line, leaves the marker it precedes as text, as Node.js leaves it. The legacy
 * label is refused rather than dropped: Node.js trusts a certificate under it, and a provider handed the material
 * without it would distrust what every other engine trusts, with nothing naming the cause. The material is the
 * certificate blocks in the file's order, each as the file spells it; every other text (a comment, a subject line, a
 * key or another PEM type Node.js does not trust) is dropped, as Node's own loader skips it. The blocks are not parsed
 * as X.509: a provider's TLS library refuses one it cannot read when it connects, by its own error.
 *
 * Who reads first: on a standalone server the CA bundle preflight (`@/lib/config/ca-bundle-preflight`), which refuses
 * an invalid file before the server serves; in a channel with no boot hook, the published package, the provider
 * factory's first build of an engine that takes the material. The outcome is kept for the life of the process, so a
 * change of the variable or of the file takes effect when Studio restarts, as it does for Node.js. A read that takes
 * the material from a set variable logs it once, with the file and the count; an unset variable logs nothing, and a
 * refusal logs nothing, since the boot banner or the thrown error speaks for it. The thrown error names the variable
 * and the reason, never the path or the content, since it can reach a browser through a route.
 *
 * The outcome lives on `globalThis` under a registered symbol, not in a module-level variable: Next.js bundles the
 * instrumentation, which reads at boot, apart from the route handlers, so one server process holds this module twice
 * (`./egress-decision` does the same for the same reason).
 *
 * Sign-in's token trust (`@/lib/openshift-auth/http`) reads the variable on its own, on every token call, by design;
 * it is not a provider. `tests/unit/lib/db/provider-environment-scan.test.ts` holds who reads the variable, who
 * imports this module, and that no module under `packages/` imports it.
 *
 * `forgetTrustMaterial` is a test seam.
 */
import { readFileSync } from "node:fs";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { TrustMaterial } from "@/lib/db/types";
import { logger } from "@/lib/logger";

const VARIABLE = "NODE_EXTRA_CA_CERTS";
const BEGIN = "-----BEGIN CERTIFICATE-----";
const END = "-----END CERTIFICATE-----";
const LEGACY_BEGIN = "-----BEGIN X509 CERTIFICATE-----";

/** A BEGIN or END line of a certificate block: the marker alone on its line, trailing blanks and a CR allowed. */
const MARKER_LINE = /^-----(BEGIN|END) CERTIFICATE-----[ \t\r]*$/gm;
/** A BEGIN line under the legacy label OpenSSL, and so Node.js, also reads as a certificate. */
const LEGACY_BEGIN_LINE = /^-----BEGIN X509 CERTIFICATE-----[ \t\r]*$/m;

const BOM = "\uFEFF";
/** A UTF-8 byte order mark at the start of the line right after an END line, where OpenSSL's next PEM read begins. */
const BOM_AFTER_END_LINE = /(?<=^-----END [^\r\n]*-----[ \t\r]*\n)\uFEFF/gm;

/**
 * The kept outcome: the material, with the bundle's path for the log line when the variable named one, or the refusal
 * of the file the variable named, with its path and the reason, for the boot banner.
 */
export type TrustSetting =
  | { readonly material: TrustMaterial; readonly path?: string }
  | { readonly invalid: { readonly path: string; readonly reason: string } };

const SETTING_KEY = Symbol.for("libredb-studio.trust-material");

type SettingHolder = { [SETTING_KEY]?: TrustSetting };

function frozenMaterial(certificates: string[]): TrustMaterial {
  return Object.freeze({ certificates: Object.freeze(certificates) });
}

/** The certificate blocks of `content` in order, or `undefined` when a block has no END line before the next block. */
function certificateBlocks(content: string): string[] | undefined {
  const blocks: string[] = [];
  let begin: number | undefined;
  for (const marker of content.matchAll(MARKER_LINE)) {
    if (marker[1] === "BEGIN") {
      if (begin !== undefined) return undefined;
      begin = marker.index;
    } else if (begin !== undefined) {
      blocks.push(content.slice(begin, marker.index + END.length));
      begin = undefined;
    }
  }
  return begin === undefined ? blocks : undefined;
}

function read(path: string | undefined): TrustSetting {
  if (path === undefined || path === "") return { material: frozenMaterial([]) };
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return { invalid: { path, reason: `the file cannot be read (${code})` } };
  }
  // The byte order marks OpenSSL ignores: the file's first, and one right after an END line.
  if (content.startsWith(BOM)) content = content.slice(BOM.length);
  content = content.replace(BOM_AFTER_END_LINE, "");
  if (content.trim() === "") return { invalid: { path, reason: "the file is empty" } };
  if (LEGACY_BEGIN_LINE.test(content)) {
    const reason = `the file holds a ${LEGACY_BEGIN} block, which Node.js trusts and Studio does not take; relabel it ${BEGIN} and ${END}`;
    return { invalid: { path, reason } };
  }
  const blocks = certificateBlocks(content);
  if (blocks === undefined) {
    return { invalid: { path, reason: `a ${BEGIN} block in the file has no ${END} line` } };
  }
  if (blocks.length === 0) return { invalid: { path, reason: `the file holds no ${BEGIN} block` } };
  return { material: frozenMaterial(blocks), path };
}

/**
 * The outcome of this process, for the CA bundle preflight: never throws. The first read reads the variable and the
 * file, keeps the outcome and, for a bundle it took, logs it; every later read returns the kept outcome.
 */
export function trustMaterialSetting(): TrustSetting {
  const holder = globalThis as SettingHolder;
  const kept = holder[SETTING_KEY];
  if (kept !== undefined) return kept;
  const setting = read(process.env.NODE_EXTRA_CA_CERTS);
  holder[SETTING_KEY] = setting;
  if ("material" in setting && setting.path !== undefined) {
    const certificates = setting.material.certificates.length;
    logger.info(`Studio read ${certificates} CA certificates from ${VARIABLE}`, {
      route: "trust-material",
      variable: VARIABLE,
      path: setting.path,
      certificates,
    });
  }
  return setting;
}

/**
 * The material the provider factory hands the engines that take it: throws a `DatabaseConfigError` naming the variable
 * and the reason for a refused file, on every call.
 */
export function trustMaterial(): TrustMaterial {
  const setting = trustMaterialSetting();
  if ("invalid" in setting) throw new DatabaseConfigError(`Invalid ${VARIABLE}: ${setting.invalid.reason}`);
  return setting.material;
}

/** Test seam: forgets this process's outcome, so the next read decides as a new process would. */
export function forgetTrustMaterial(): void {
  delete (globalThis as SettingHolder)[SETTING_KEY];
}
