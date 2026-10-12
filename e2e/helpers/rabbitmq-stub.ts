/**
 * A stub RabbitMQ management API for e2e/rabbitmq-provider.spec.ts: plain HTTP on a loopback port the system picks,
 * answering every GET from the 4.3.6 capture `session-studio-reader` of tests/fixtures/rabbitmq/, keyed exactly as the
 * integration test's replay keys it, by the management API stub's `requestKey`. A request nobody recorded answers a
 * `text/plain` 404 and is kept in `unrecorded`, so a failing spec can say which read the capture plan lacks; every
 * request is kept in `requests`. The stub opens no AMQP listener: stream reads in the browser are the manual live pass.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadManagementCapture, stubKey } from "../../tests/helpers/rabbitmq-captures";
import { requestKey } from "../../tests/helpers/rabbitmq-management-stub";

export interface RabbitMQStub {
  readonly port: number;
  readonly requests: string[];
  readonly unrecorded: string[];
  close(): Promise<void>;
}

export async function startRabbitMQStub(): Promise<RabbitMQStub> {
  const answers = new Map(
    loadManagementCapture("4.3.6", "session-studio-reader").exchanges.map((exchange) => [stubKey(exchange), exchange]),
  );
  const requests: string[] = [];
  const unrecorded: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = `http://127.0.0.1${request.url ?? "/"}`;
    const key = request.method === "GET" ? requestKey({ method: "GET", url }) : `${request.method ?? "?"} ${url}`;
    requests.push(key);
    const answer = request.method === "GET" ? answers.get(key) : undefined;
    if (!answer) {
      unrecorded.push(key);
      response.writeHead(404, { "content-type": "text/plain" }).end("not recorded");
      return;
    }
    response.writeHead(answer.status, { "content-type": answer.contentType ?? "application/json" }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    unrecorded,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
