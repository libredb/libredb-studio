/**
 * Readiness probe for the OPC UA fixture: does the SERVER answer, not does a port accept.
 *
 * `docker/opcua/ci-step.yml` runs this as the second of two readiness checks. A published port
 * answers as soon as Docker's proxy binds it, so a TCP connect measures Docker rather than the
 * fixture; GetEndpoints measures the fixture. It runs on an unsecured channel and before any
 * session exists, which is what makes it cheap enough for a loop.
 *
 * Prints `GETENDPOINTS_OK <count>` and exits 0 when the server answered, exits 1 otherwise, so a
 * caller can branch on either the line or the status.
 */
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { OPCUA_LIBRARY_BRIDGE } from "@/lib/db/providers/industrial/opcua/library";

const endpointUrl = process.argv[2] ?? process.env.LIBREDB_OPCUA_LIVE_URL ?? "opc.tcp://127.0.0.1:54840/";

try {
  const endpoints = await OPCUA_LIBRARY_BRIDGE.readEndpoints({ endpointUrl } as never);
  // An empty list is an answer about a server that offers nothing, not a server that answered:
  // the fixture publishes seven, and a zero here would make the loop above pass on silence.
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    console.error(`the server at ${endpointUrl} answered GetEndpoints with no endpoint at all`);
    process.exit(1);
  }
  console.log(`GETENDPOINTS_OK ${endpoints.length}`);
} catch (error) {
  console.error(`${endpointUrl}: ${(error as Error).message}`);
  process.exit(1);
}
