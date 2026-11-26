/**
 * What `docs/SECURITY.md` says about Kafka: the further hosts a broker's metadata chooses, the SSH tunnel refusal,
 * and the client work a broker drives (decompression, SCRAM iterations, re-authentication), in the any-host bullet.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const SECURITY = read("docs/SECURITY.md");
/** The bullet of `text` that starts with `head`, up to the next top-level bullet or heading, or undefined. */
function bulletOf(text: string, head: string): string | undefined {
  const start = text.indexOf(`\n- ${head}`);
  if (start < 0) return undefined;
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(- |#)/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("SECURITY.md's Kafka widening of the any-host limitation", () => {
  test("bulletOf reads the any-host bullet alone and finds no bullet that does not exist", () => {
    const limitation = bulletOf(SECURITY, "**A `user` can connect to any host and port");
    expect(limitation).toBeDefined();
    expect(limitation).not.toContain("Local login credentials are not hashed");
    expect(bulletOf(SECURITY, "**No such limitation")).toBeUndefined();
  });

  const limitation = bulletOf(SECURITY, "**A `user` can connect to any host and port") ?? "";
  test("a Kafka broker's metadata chooses the further hosts, with the connection's credentials (K2)", () => {
    expect(limitation).toContain(
      "A Kafka broker's metadata chooses the further hosts Studio connects to, with the connection's SASL credentials",
    );
    expect(limitation).toContain(
      "Use TLS with verify-full so credentials reach only hosts whose certificate the configured CA vouches for.",
    );
  });

  test("a Kafka connection refuses an SSH tunnel, for the same reason", () => {
    expect(limitation).toContain("A Kafka connection refuses an SSH tunnel");
  });

  test("the client's decompression before any bound is stated as accepted (K5)", () => {
    expect(limitation).toContain("decompresses every batch of a fetch response whole");
    expect(limitation).toContain("about 1,029 to 1 for gzip and 32,692 to 1 for zstd");
  });

  test("the SCRAM work a broker chooses is stated as accepted, beside the decompression", () => {
    expect(limitation).toContain(
      "The Kafka client's SCRAM exchange runs PBKDF2 over the password as many times as the broker's first SCRAM answer asks, checking only the lower bound, while Apache Kafka 4.3.1 stores no credential above 16,384 iterations",
    );
  });

  test("the re-authentication a broker's session lifetime drives is stated as accepted, beside the SCRAM work", () => {
    expect(limitation).toContain(
      "A broker that answers a SASL authentication with a session lifetime (KIP-368) has the Kafka client authenticate again at 80% of it, for as long as the connection is open and with no floor",
    );
  });
});
