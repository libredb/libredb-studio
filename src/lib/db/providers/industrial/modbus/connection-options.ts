/**
 * What the connection says about where to dial and whether to dial it with TLS.
 *
 * A module of its own for the reason every other panel-reading provider has one
 * (`mtconnect/connection-options.ts`, `rabbitmq/connection-options.ts`, `s3/connection-options.ts`):
 * reading the SSL / TLS panel is a pure step over a connection record, and a pure step inside a
 * provider method can only be measured by opening a socket. Here it is measured directly.
 *
 * WHY THIS EXISTS AT ALL. The provider used to read `config.ssl?.enabled`, and `SSLConfig` has no
 * `enabled`: it has `mode`, and `enabled` belongs to the SSH tunnel. The test was never true, so
 * `mbaps` could not be reached from the dialog - while the dialog says the panel turns it on, the
 * refusal for exception 01 mentions a certificate's role, and `docs/providers/modbus.md` says
 * `mbaps` checks the chain and the host name. Six sentences about a mode no connection could enter.
 */
import { nodeTlsMaterial } from "@/lib/db/http/node-transport";
import type { DatabaseConnection } from "@/lib/types";
import type { Endpoint } from "./client";
import { MODBUS_DEFAULT_PORT } from "./constants";

/**
 * Host, port and the panel's material. 502 where no port is set, and `127.0.0.1` where no host is:
 * a device on the machine running Studio is the one case a plant engineer reaches with the box
 * left empty.
 *
 * `nodeTlsMaterial` is the one place a panel is read, so the mode, the trust anchor and the client
 * pair are checked here exactly as they are for AMQP and the HTTP transport: `disable` is no TLS
 * rather than TLS that verifies nothing, a mode the panel does not define is refused, and half a
 * client pair is refused rather than dialled with half of one.
 */
export function modbusEndpoint(config: DatabaseConnection): Endpoint {
  const host = config.host ?? "127.0.0.1";
  const tls = nodeTlsMaterial(config.ssl, host);
  return {
    host,
    port: config.port ?? MODBUS_DEFAULT_PORT,
    ...(tls === null ? {} : { tls }),
  };
}
