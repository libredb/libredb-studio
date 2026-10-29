/**
 * Boot-time check of `NODE_EXTRA_CA_CERTS`.
 *
 * Node reads the variable once, when the process starts, and when the named file
 * is missing, unreadable or holds no certificate it prints a single warning and
 * trusts nothing extra. Every TLS connection to a database or identity provider
 * behind the private CA then fails later, at sign-in or at the first query, far
 * from the cause, while the health check stays green.
 *
 * Refusing to boot makes the failure visible and lets a restart fix it: on
 * OpenShift the chart's trusted-CA ConfigMap starts empty and the Cluster Network
 * Operator fills it after the pod may already have started, so the kubelet's
 * restart picks the bundle up once it is there. The same wrong path under Docker
 * or `npx` is the same silent trust failure, so the check applies to every
 * standalone start.
 *
 * Checks nothing when the variable is unset or empty. Never prints file content,
 * only the path and the reason.
 */

import { readFileSync } from "node:fs";

const PEM_CERTIFICATE_MARKER = "-----BEGIN CERTIFICATE-----";

function refuse(path: string, reason: string): false {
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: NODE_EXTRA_CA_CERTS names no certificate bundle",
      ` Path: ${path}`,
      ` Reason: ${reason}`,
      " Node would only warn and trust no extra CA, so every TLS connection",
      " behind the private CA would fail later. Fix it either way:",
      "   1. Point NODE_EXTRA_CA_CERTS at a PEM file holding the CA certificates",
      "   2. Unset NODE_EXTRA_CA_CERTS when no private CA is needed",
      " On OpenShift with openshift.trustedCABundle.enabled, the cluster fills",
      " the bundle shortly after install; the restart picks it up.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}

/**
 * Validate the file `NODE_EXTRA_CA_CERTS` names. Returns true when the variable
 * is unset or empty, or the file holds a PEM certificate block; otherwise prints
 * a banner, exits with status 1 and returns false.
 */
export function verifyExtraCaCertsAtBoot(): boolean {
  const path = process.env.NODE_EXTRA_CA_CERTS;
  if (!path) return true;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return refuse(path, `the file cannot be read (${code})`);
  }

  if (content.trim() === "") {
    return refuse(path, "the file is empty");
  }
  if (!content.includes(PEM_CERTIFICATE_MARKER)) {
    return refuse(path, `the file holds no ${PEM_CERTIFICATE_MARKER} block`);
  }
  return true;
}
