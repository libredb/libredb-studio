/**
 * Where the client's own key pair and trust store live (#1677 O-S4).
 *
 * THE LIBRARY'S DEFAULT CANNOT WORK IN THE PRODUCT IMAGE, AND THAT IS MEASURED, NOT FEARED. On a
 * first connect, even in None mode, `node-opcua-client` generates a private key and a self-signed
 * client certificate under the platform's own config directory, with `trusted`, `rejected` and
 * `issuers` beside them. Measured paths:
 *
 * | Platform | Default root |
 * |---|---|
 * | Linux (the image) | `$HOME/.config/node-opcua-default-nodejs/PKI` |
 * | macOS (a developer) | `$HOME/Library/Preferences/node-opcua-default-nodejs/PKI` |
 *
 * The issue named the Linux path as THE path; it is one of several, because `env-paths` answers per
 * platform. Either way the product image cannot use it: measured on
 * `ghcr.io/libredb/libredb-studio:0.18.2`, the process runs as uid 1001 whose passwd entry is
 * `/nonexistent`, `os.homedir()` is `/nonexistent`, the directory does not exist, and a `mkdir`
 * there fails `EACCES`. The issue's O-S4 describes a "read-only or ephemeral home"; the measured
 * state is neither. It is a home that cannot be created at all, so the default would not be awkward
 * in production, it would simply fail.
 *
 * Hence the root never falls back to a setting that depends on `HOME`. It falls back to a directory
 * Studio ALREADY owns and writes - `<data directory>/opcua-pki`, beside the storage database - and
 * the variable overrides it with an absolute path. Requiring the variable was the first answer here,
 * and a browser measured what it cost: a reader who installed Studio, picked OPC UA and pressed Test
 * Connection was told the engine needs a directory nobody had mentioned, so the engine could not be
 * used at all until they found an environment variable. A connection may also supply the certificate
 * and key itself, which is what a mounted secret is for. Two replicas sharing one mounted key present
 * one identity to the server's administrator, rather than one per pod to be trusted one by one.
 *
 * THE ROOT IS CORE'S DECISION, NOT THIS PROVIDER'S (FND-2 slice 3): `opcuaPkiRoot` in
 * `src/lib/db/provider-files.ts` reads `LIBREDB_OPCUA_PKI_ROOT`, or takes `opcua-pki` under the data
 * directory Studio took once per process, refuses a relative value before the provider is built, and
 * the provider factory hands the root to the provider. This module keeps the client identity's rule.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { OPCUA_TYPE } from "./constants";

/**
 * Whether the client's own certificate was supplied rather than generated.
 *
 * Supplied is the better answer for a deployment with more than one replica, because the server's
 * administrator then trusts one certificate instead of one per pod. Generated is the answer for a
 * single instance with a mounted directory, where the key survives a restart.
 */
export function clientIdentitySource(options: {
  readonly certificatePath?: string;
  readonly privateKeyPath?: string;
}): "supplied" | "generated" {
  const hasCertificate = (options.certificatePath ?? "").trim() !== "";
  const hasKey = (options.privateKeyPath ?? "").trim() !== "";
  if (hasCertificate !== hasKey) {
    throw new DatabaseConfigError(
      "A client certificate and its private key are supplied together or not at all: one without the other " +
        "cannot open a secured channel.",
      OPCUA_TYPE,
    );
  }
  return hasCertificate ? "supplied" : "generated";
}
