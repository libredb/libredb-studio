/**
 * The editor's integration capture records what the device sent, and a `<get-config>` of
 * `running` on the fixture answers the read-only account's own password hash. A capture records
 * no credential value, so the recorder overwrites every credential element's text before it
 * writes, keeping each chunk's length, because the chunked framing counts the bytes it carries.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrubCredentialValues } from "../../../live/netconf-capture-scrub";

const SESSION = path.resolve(import.meta.dir, "../../../fixtures/netconf/session.json");
const CREDENTIAL_TEXT = /<(hashed-password|cleartext-password|cleartext-private-key|cleartext-symmetric-key)>([^<]*)</g;

describe("the NETCONF evidence capture's credential scrub", () => {
  test("overwrites a credential element's text with as many characters, across a chunk boundary", () => {
    const chunks = ["<user><password><hashed-password>$6$sa", "lt$abcdef</hashed-password></password>"];
    const scrubbed = scrubCredentialValues(chunks);
    expect(scrubbed.map((chunk) => chunk.length)).toEqual(chunks.map((chunk) => chunk.length));
    expect(scrubbed.join("")).toBe(
      `<user><password><hashed-password>${"x".repeat("$6$salt$abcdef".length)}</hashed-password></password>`,
    );
  });

  test("leaves every other element's text alone", () => {
    const chunks = ["<name>ge-0/0/1</name><description>uplink</description>"];
    expect(scrubCredentialValues(chunks)).toEqual(chunks);
  });

  test("the committed capture carries no credential value", () => {
    const capture = JSON.parse(readFileSync(SESSION, "utf8")) as {
      hello: string[];
      exchanges: { chunks: string[] }[];
    };
    const bodies = [capture.hello.join(""), ...capture.exchanges.map((exchange) => exchange.chunks.join(""))];
    for (const body of bodies) {
      for (const match of body.matchAll(CREDENTIAL_TEXT)) expect(match[2]).toMatch(/^x*$/);
    }
  });
});
