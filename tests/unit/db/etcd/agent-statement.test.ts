/**
 * The etcd agent's command reader: the closed table of metadata reads, each read to the one fixed request the
 * provider sends, and every refusal made before anything is sent, with a sentence that quotes nothing the command
 * wrote.
 */
import { describe, expect, test } from "bun:test";
import {
  ETCD_AGENT_MAX_KEY_BYTES,
  ETCD_AGENT_SENTENCES,
  type EtcdAgentReading,
  readEtcdAgentStatement,
} from "@/lib/db/providers/keyvalue/etcd/agent-statement";

const encode = (text: string) => new TextEncoder().encode(text);

describe("the closed table", () => {
  test.each([
    ["endpoint status", { op: "endpoint status" }],
    ["member list", { op: "member list" }],
    ["member list --consistency=l", { op: "member list" }],
    ["alarm list", { op: "alarm list" }],
    ["auth status", { op: "auth status" }],
    ["lease list", { op: "lease list" }],
    ["lease timetolive 694d8147df1dc4c8", { op: "lease timetolive", leaseHex: "694d8147df1dc4c8" }],
    ['get "" --prefix --count-only', { op: "key count" }],
    ['get --count-only --prefix ""', { op: "key count" }],
    ['get "" --from-key --count-only', { op: "key count" }],
    ["get /app/config", { op: "key metadata", key: encode("/app/config") }],
    ['get "/app/a key"', { op: "key metadata", key: encode("/app/a key") }],
    ["  get /app/config  ", { op: "key metadata", key: encode("/app/config") }],
  ])("%s reads to its one fixed request", (text, plan) => {
    expect(readEtcdAgentStatement(text)).toEqual({ ok: true, plan } as EtcdAgentReading);
  });

  test("a key of the longest length is read, and one byte more is refused", () => {
    const longest = `/${"k".repeat(ETCD_AGENT_MAX_KEY_BYTES - 1)}`;
    expect(readEtcdAgentStatement(`get ${longest}`)).toEqual({
      ok: true,
      plan: { op: "key metadata", key: encode(longest) },
    });
    expect(readEtcdAgentStatement(`get ${longest}k`)).toEqual({
      ok: false,
      code: "arguments",
      message: ETCD_AGENT_SENTENCES.key,
    });
  });
});

describe("every request outside the table is refused before anything is sent", () => {
  test.each([
    "put /app/config value",
    "del /app/config",
    "del /app/ --prefix",
    "txn",
    "watch /app/config",
    "lease grant 60",
    "lease revoke 694d8147df1dc4c8",
    "lease keep-alive 694d8147df1dc4c8 --once",
    "lease timetolive 694d8147df1dc4c8 --keys",
    "endpoint health",
    "user list",
    "user get root",
    "role list",
    "role get reader",
    "get /app/ --prefix",
    "get /app/ --from-key",
    "get /app/a /app/z",
    "get /app/ --prefix --keys-only",
    "get /app/config --keys-only",
    "get /app/ --prefix --count-only",
    "get /a --count-only",
    'get "" --prefix',
    'get "" --from-key',
  ])("%s is metadata-only's refusal", (text) => {
    expect(readEtcdAgentStatement(text)).toEqual({
      ok: false,
      code: "metadata-only",
      message: ETCD_AGENT_SENTENCES.metadataOnly,
    });
  });

  test.each([
    "get /app/config --rev=3",
    "get /app/config --limit=1",
    "get /app/config --limit=100000",
    "get /app/config --consistency=s",
    "member list --consistency=s",
    "get /app/config --command-timeout=3s",
    'get "" --prefix --count-only --rev=2',
  ])("%s carries a flag the provider owns, and is refused", (text) => {
    expect(readEtcdAgentStatement(text)).toEqual({ ok: false, code: "arguments", message: ETCD_AGENT_SENTENCES.flags });
  });

  test('get "" names no key and is refused, by the parser as etcd would refuse it', () => {
    expect(readEtcdAgentStatement('get ""')).toMatchObject({ ok: false, code: "request" });
  });

  test.each(["", "   ", "\n\t", "# a comment only"])("an empty request (%j) holds no command", (text) => {
    expect(readEtcdAgentStatement(text)).toEqual({ ok: false, code: "request", message: ETCD_AGENT_SENTENCES.empty });
  });

  test("a request the editor's parser refuses is refused with the parser's sentence, which quotes no value", () => {
    const second = readEtcdAgentStatement("get /app/config\nput /app/config secret-value");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("request");
    expect(second.message).toContain("Line 2 holds a second command");
    expect(second.message).not.toContain("secret-value");
    expect(second.message.endsWith("Nothing was sent.")).toBe(true);
    const unknown = readEtcdAgentStatement("snapshot save /tmp/x");
    expect(unknown).toMatchObject({ ok: false, code: "request" });
    const refused = readEtcdAgentStatement("get /app/config --print-value-only");
    expect(refused).toMatchObject({ ok: false, code: "request" });
  });

  test("a refusal never quotes the key the command named", () => {
    for (const text of ["get /secret/token --keys-only", "put /secret/token v", "get /secret/token --rev=2"]) {
      const reading = readEtcdAgentStatement(text);
      expect(reading.ok).toBe(false);
      if (!reading.ok) expect(reading.message).not.toContain("/secret/token");
    }
  });

  test("the sentences name the reads the table holds and say nothing was sent", () => {
    for (const sentence of [
      ETCD_AGENT_SENTENCES.empty,
      ETCD_AGENT_SENTENCES.metadataOnly,
      ETCD_AGENT_SENTENCES.flags,
    ]) {
      expect(sentence).toContain("endpoint status, member list, alarm list, auth status, lease list");
      expect(sentence.endsWith("Nothing was sent.")).toBe(true);
    }
    expect(ETCD_AGENT_SENTENCES.request("Refused.")).toBe("Refused. Nothing was sent.");
  });
});
