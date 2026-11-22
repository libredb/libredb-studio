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
 *
 * The check is core's read of the trust material (`trustMaterialSetting` in
 * `@/lib/db/trust-material`), which keeps the file's CA certificates for the life of the
 * process for the providers whose TLS does not read Node's store (Db2). So the boot read is the
 * read every later build of such a provider is handed, as Node's own read at start is the one
 * its TLS keeps, and the files refused here are the files that module refuses: missing,
 * unreadable, empty, holding a block under the legacy `X509 CERTIFICATE` label, holding no
 * certificate block, or leaving one with no END line.
 */

import { trustMaterialSetting } from "@/lib/db/trust-material";

function refuse(path: string, reason: string): false {
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: NODE_EXTRA_CA_CERTS names a file Studio does not accept as a certificate bundle",
      ` Path: ${path}`,
      ` Reason: ${reason}`,
      " Node would warn and trust none or only part of it, or, for a legacy label,",
      " trust a CA that Studio's Db2 connections would not, so TLS connections",
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
 * Validate the file `NODE_EXTRA_CA_CERTS` names, through core's read of it. Returns true
 * when the variable is unset or empty, or the file's certificate blocks were taken;
 * otherwise prints a banner, exits with status 1 and returns false.
 */
export function verifyExtraCaCertsAtBoot(): boolean {
  const setting = trustMaterialSetting();
  if ("invalid" in setting) return refuse(setting.invalid.path, setting.invalid.reason);
  return true;
}
