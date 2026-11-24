/**
 * The Databend HTTP transport over TLS (design 3.14; C2), against a local `node:https` server presenting the committed
 * throwaway material of tests/fixtures/tls/ (`loadTlsFixtures`): a private CA verifies, the wrong CA is `tls` with
 * nothing sent, `require` reaches a certificate it cannot verify, a client pair is presented, and through a tunnel the
 * certificate is checked against the far end, never the local forward that is dialled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import type { DatabendError, DatabendTransport } from "@/lib/db/providers/sql/databend/transport";
import type { DatabendConnectionOptions } from "@/lib/db/providers/sql/databend/connection-options";
import { answerBody, statement, testOptions, wireIds } from "../../../helpers/databend-node-transport";
import { closeAll, httpsListener, type Listener } from "../../../helpers/node-transport-fixtures";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const tls = loadTlsFixtures();
const transports: DatabendTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await closeAll();
});

/** Answers every POST as a finished one-row statement for the ids it carried. */
function oneRow(request: IncomingMessage, response: ServerResponse): void {
  const ids = wireIds(request.headers);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify(
      answerBody({
        id: ids.queryId,
        session_id: ids.sessionId,
        schema: [{ name: "one", type: "UInt8" }],
        data: [["1"]],
      }),
    ),
  );
}

function run(options: DatabendConnectionOptions) {
  const transport = createDatabendHttpTransport(options, { latch: createAuthLatch({ now: Date.now }) });
  transports.push(transport);
  return transport.run(statement("SELECT 1 AS one"));
}

async function failure(options: DatabendConnectionOptions): Promise<DatabendError> {
  return (await run(options).catch((caught: unknown) => caught)) as DatabendError;
}

function listen(extra: { readonly clientCa?: string } = {}): Promise<Listener> {
  return httpsListener({ ...tls.server, ...extra }, oneRow);
}

describe("C2", () => {
  test("a private CA verifies, and the statement runs over https", async () => {
    const listener = await listen();
    const options = testOptions({ port: listener.port, ssl: { mode: "verify-ca", caCert: tls.ca } });
    expect(options.origin.scheme).toBe("https");
    expect((await run(options)).rows).toEqual([["1"]]);
    expect(listener.seen).toHaveLength(1);
  });

  test("the wrong CA is tls, and nothing reaches the handler", async () => {
    const listener = await listen();
    const error = await failure(testOptions({ port: listener.port, ssl: { mode: "verify-ca", caCert: tls.otherCa } }));
    expect(error.category).toBe("tls");
    expect(listener.seen).toHaveLength(0);
  });

  test("require reaches a certificate it cannot verify", async () => {
    const listener = await listen();
    expect((await run(testOptions({ port: listener.port, ssl: { mode: "require" } }))).rows).toEqual([["1"]]);
  });

  test("a client pair is presented to a server that requires one", async () => {
    const listener = await listen({ clientCa: tls.clientCa });
    const ssl = { mode: "verify-ca", caCert: tls.ca, clientCert: tls.client.cert, clientKey: tls.client.key };
    expect((await run(testOptions({ port: listener.port, ssl }))).rows).toEqual([["1"]]);
  });

  describe("through a tunnel", () => {
    // The bastion route, as Studio's provider factory hands it to a tunnelled provider beside the far end.
    const route = "4:true12:bastion.test2:224:jump";

    test("the certificate is checked against the far end's name", async () => {
      const listener = await listen();
      const options = testOptions(
        { port: listener.port, ssl: { mode: "verify-full", caCert: tls.ca } },
        { tunnel: { farEnd: { host: "localhost", port: 8000 }, route } },
      );
      expect((await run(options)).rows).toEqual([["1"]]);
    });

    test("never the local forward's: a far end the certificate does not name is tls, though 127.0.0.1 is on it", async () => {
      const listener = await listen();
      const options = testOptions(
        { port: listener.port, ssl: { mode: "verify-full", caCert: tls.ca } },
        { tunnel: { farEnd: { host: "databend.internal", port: 8000 }, route } },
      );
      expect((await failure(options)).category).toBe("tls");
      expect(listener.seen).toHaveLength(0);
    });
  });
});
