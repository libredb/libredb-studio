/**
 * Opt-in live check of KE8 for the etcd provider (#1089, spec E5): through a real SSH tunnel, a
 * `verify-full` connection is checked against the far end's name, never against the tunnel's local
 * `127.0.0.1`, and a far end the certificate does not name is refused through the same forward.
 *
 * Apart from `tests/live/etcd-live-check.ts` because it builds the provider through
 * `getOrCreateProvider`, the only path that opens a tunnel and sets `TUNNEL_FAR_END`, and the factory
 * statically imports every engine's provider, which the Node bundle of that check must not carry.
 *
 * Run it with the bastion of Task 22 Step 18 up and the certificates copied out:
 *
 *   ETCD_LIVE_CERTS=<dir> LIVE_SSH_PASSWORD=... bun tests/live/etcd-tunnel-check.ts
 *
 * The password has no default, and neither does any credential here.
 */
import { execFileSync } from "node:child_process";
import { getOrCreateProvider, removeProvider } from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/types";
import { readCertificateDirectory } from "./etcd-live-support";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`Set ${name}: this check talks to a real bastion and a real etcd.`);
  return value;
}

const certs = readCertificateDirectory(required("ETCD_LIVE_CERTS"));
const tunnel = {
  enabled: true,
  host: "127.0.0.1",
  port: 12222,
  username: "tunnel",
  authMethod: "password" as const,
  password: required("LIVE_SSH_PASSWORD"),
};
const byName: DatabaseConnection = {
  id: "etcd-live-ke8-name",
  name: "etcd live KE8 by name",
  type: "etcd",
  // The far end as the bastion sees it: the compose service name, which the server certificate names.
  host: "etcd-auth-password",
  port: 2379,
  user: "reader",
  password: certs["reader.password"],
  ssl: { mode: "verify-full", caCert: certs["ca.pem"] },
  sshTunnel: tunnel,
  createdAt: new Date(),
};
// The same server by its address on the compose network, which the certificate does not carry.
const address = execFileSync(
  "docker",
  ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "libredb-etcd-auth-password"],
  { encoding: "utf8" },
).trim();
const byAddress: DatabaseConnection = {
  ...byName,
  id: "etcd-live-ke8-address",
  name: "etcd live KE8 by address",
  host: address,
};
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

let failed = 0;
try {
  const provider = await getOrCreateProvider(byName);
  const dialled = `${provider.config.host}:${provider.config.port}`;
  if (provider.config.host !== "127.0.0.1") throw new Error(`no tunnel was opened: the provider dials ${dialled}`);
  const result = await provider.query("get /config/a");
  console.log(
    `PASS KE8: verify-full through the tunnel checks the far end's DNS name: ${result.rowCount} rows, dialled ${dialled}`,
  );
} catch (error) {
  failed++;
  console.log(`FAIL KE8 by name: ${describe(error)}`);
} finally {
  await removeProvider(byName.id);
}
try {
  await getOrCreateProvider(byAddress);
  failed++;
  console.log(`FAIL KE8 by address: ${address} connected with a certificate that does not name it`);
} catch (error) {
  if (error instanceof Error && error.name === "ConnectionError" && error.message.includes("does not name")) {
    console.log(`PASS KE8: the same certificate is refused for a far end it does not name: ${describe(error)}`);
  } else {
    failed++;
    console.log(`FAIL KE8 by address: expected the name refusal, got ${describe(error)}`);
  }
} finally {
  await removeProvider(byAddress.id);
}
console.log(`${2 - failed} of 2 checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
