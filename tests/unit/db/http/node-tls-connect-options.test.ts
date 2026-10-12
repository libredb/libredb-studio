/**
 * nodeTlsConnectOptions: the TLS options of the SSL / TLS panel under node:tls's own names, one object that the HTTPS
 * Agent and a plain `tls.connect` both take. A server name is sent only for a DNS identity, and the certificate is
 * checked against the identity, never against the address dialled, so a tunnel's local forward is checked as its far end.
 *
 * The certificates are made with openssl when this file starts and never committed (makeCertificates in
 * tests/helpers/node-transport-fixtures.ts).
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { nodeTlsConnectOptions, type NodeTlsConnectOptions, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import type { SSLConfig } from "@/lib/types";
import {
  closeAll,
  httpsListener,
  jsonAnswer,
  type Listener,
  makeCertificates,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

afterEach(async () => {
  await closeAll();
});

const verifyFull = (caCert: string): SSLConfig => ({ mode: "verify-full", caCert });

function optionsFor(ssl: SSLConfig, identity: string): NodeTlsConnectOptions {
  const material = nodeTlsMaterial(ssl, identity);
  if (material === null) throw new Error("expected TLS material");
  return nodeTlsConnectOptions(material);
}

/** One GET over a plain tls.connect to 127.0.0.1, written by hand: the status line, or the handshake's error code. */
function getOverTlsConnect(listener: Listener, options: NodeTlsConnectOptions): Promise<string> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: "127.0.0.1", port: listener.port, ...options });
    const chunks: Buffer[] = [];
    socket.once("secureConnect", () => socket.end("GET / HTTP/1.1\r\nhost: tls.test\r\nconnection: close\r\n\r\n"));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("latin1").split("\r\n")[0]));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code ?? error.name);
    });
  });
}

/** The same GET through an HTTPS Agent built from the same options: the status code, or the error code. */
function getOverAgent(listener: Listener, options: NodeTlsConnectOptions): Promise<string> {
  const agent = new HttpsAgent({ ...options, keepAlive: false });
  return new Promise<string>((resolve) => {
    const request = httpsRequest({ host: "127.0.0.1", port: listener.port, path: "/", agent }, (response) => {
      response.resume();
      response.once("end", () => resolve(String(response.statusCode)));
    });
    request.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.name));
    request.end();
  }).finally(() => agent.destroy());
}

describe("the options object", () => {
  test("a DNS identity is sent as the server name", () => {
    expect(optionsFor(verifyFull("ca"), "db.example.com").servername).toBe("db.example.com");
  });

  test.each(["127.0.0.1", "::1", "10.0.0.5"])("the IP identity %s sends no server name", (identity) => {
    expect(Object.hasOwn(optionsFor(verifyFull("ca"), identity), "servername")).toBe(false);
  });

  test("the panel's CA, client certificate and key are carried only when the panel has them", () => {
    const bare = optionsFor({ mode: "require" }, "localhost");
    expect(bare.rejectUnauthorized).toBe(false);
    expect(Object.keys(bare).sort()).toEqual(["checkServerIdentity", "rejectUnauthorized", "servername"]);

    const full = optionsFor(
      {
        mode: "verify-full",
        caCert: certificates.ca,
        clientCert: certificates.client.cert,
        clientKey: certificates.client.key,
      },
      "localhost",
    );
    expect(full.rejectUnauthorized).toBe(true);
    expect(Buffer.isBuffer(full.ca)).toBe(true);
    expect(Buffer.isBuffer(full.cert)).toBe(true);
    expect(Buffer.isBuffer(full.key)).toBe(true);
  });
});

describe("the HTTPS Agent and tls.connect take the same object and agree", () => {
  test("a DNS identity: both reach the far end's certificate and send its name", async () => {
    const listener = await httpsListener(certificates.farName, jsonAnswer(200, "{}"));
    const options = optionsFor(verifyFull(certificates.ca), "qdrant.test");
    expect(await getOverAgent(listener, options)).toBe("200");
    expect(await getOverTlsConnect(listener, options)).toBe("HTTP/1.1 200 OK");
    expect(listener.seen.map((seen) => seen.servername)).toEqual(["qdrant.test", "qdrant.test"]);
  });

  test("an IP identity: both check the certificate's IP SAN against the identity and send no server name", async () => {
    const listener = await httpsListener(certificates.farAddress, jsonAnswer(200, "{}"));
    const options = optionsFor(verifyFull(certificates.ca), "10.0.0.5");
    expect(await getOverAgent(listener, options)).toBe("200");
    expect(await getOverTlsConnect(listener, options)).toBe("HTTP/1.1 200 OK");
    expect(listener.seen.map((seen) => seen.servername)).toEqual([false, false]);
  });

  test("the identity, not the address dialled, is checked: a certificate for another name fails on both", async () => {
    const listener = await httpsListener(certificates.farName, jsonAnswer(200, "{}"));
    const options = optionsFor(verifyFull(certificates.ca), "localhost");
    expect(await getOverAgent(listener, options)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(await getOverTlsConnect(listener, options)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(listener.seen).toHaveLength(0);
  });
});
