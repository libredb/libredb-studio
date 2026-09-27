/** Optional outbound address policy for HTTP database transports. */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { urlToHttpOptions } from "node:url";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { DatabaseConfigError } from "@/lib/db/errors";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const BLOCKED_HOST = "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS";
const BLOCKED_CONFIG = `Invalid ${FLAG}: expected true or false`;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

/** Unset and false preserve local-first connections. Invalid opt-in values fail closed. */
function blockPrivateHttpHosts(): boolean {
  const value = process.env[FLAG]?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "false" || value === "off" || value === "0") return false;
  if (value === "true" || value === "on" || value === "1") return true;
  throw new DatabaseConfigError(BLOCKED_CONFIG);
}

/** Block all non-public address forms before a socket can be opened. */
export function assertPublicLiteralHost(host: string): void {
  if (!blockPrivateHttpHosts()) return;
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(address);
  if (family !== 0 && blocked.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw new DatabaseConfigError(BLOCKED_HOST);
  }
}

/** All DNS answers must be safe: a mixed A/AAAA result must not be partially accepted. */
export function assertPublicDnsAnswers(addresses: readonly LookupAddress[]): void {
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => {
      if (family !== 4 && family !== 6) return true;
      if (isIP(address) !== family) return true;
      return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
    })
  )
    throw new DatabaseConfigError(BLOCKED_HOST);
}

/** The checked DNS answer is returned to the socket itself, preventing a second lookup/rebind. */
export const publicAddressLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    try {
      assertPublicDnsAnswers(addresses);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    } catch (refusal) {
      callback(refusal as NodeJS.ErrnoException, []);
    }
  });
};

/** Disable socket reuse so an earlier unguarded connection cannot bypass lookup. */
export function guardedNodeOptions(hostname: string | null | undefined): Pick<RequestOptions, "lookup" | "agent"> {
  if (!blockPrivateHttpHosts()) return {};
  if (!hostname) throw new DatabaseConfigError(BLOCKED_HOST);
  assertPublicLiteralHost(hostname);
  return { lookup: publicAddressLookup, agent: false };
}

/**
 * The restricted mode uses Node's request socket so its DNS lookup can validate and
 * pin the address. The default path remains the transport's native fetch, including
 * its test injection point and normal local-network behavior.
 */
export function httpTransportFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (!blockPrivateHttpHosts()) return globalThis.fetch(input, init);

  const url = new URL(String(input));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DatabaseConfigError(BLOCKED_HOST);
  const target = urlToHttpOptions(url);
  const options: RequestOptions = {
    ...target,
    ...guardedNodeOptions(target.hostname),
    method: init.method ?? "GET",
    headers: Object.fromEntries(new Headers(init.headers)),
    signal: init.signal ?? undefined,
  };

  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(options, (incoming) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        let body: Readable = incoming;
        const encoding = headers.get("content-encoding")?.toLowerCase();
        if (encoding === "gzip") body = incoming.pipe(createGunzip());
        else if (encoding === "deflate") body = incoming.pipe(createInflate());
        else if (encoding === "br") body = incoming.pipe(createBrotliDecompress());
        if (body !== incoming) {
          // A capped reader may cancel the decoded stream. Tear down the source
          // socket too, and forward a socket failure to a reader waiting on it.
          incoming.on("error", (error) => body.destroy(error));
          body.on("close", () => incoming.destroy());
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        const status = incoming.statusCode ?? 0;
        const noBody = [204, 205, 304].includes(status) || options.method === "HEAD";
        resolve(
          new Response(noBody ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>), {
            status,
            statusText: incoming.statusMessage,
            headers,
          }),
        );
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    // Every current HTTP database transport sends only a string body, if any.
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      request.destroy();
      reject(new TypeError("HTTP database request body must be a string"));
      return;
    }
    request.end(init.body ?? undefined);
  });
}
