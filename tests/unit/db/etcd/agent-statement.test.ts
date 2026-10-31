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

  test("a second command is refused with the parser's sentence, which quotes no value", () => {
    const second = readEtcdAgentStatement("get /app/config\nput /app/config secret-value");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("request");
    expect(second.message).toContain("Line 2 holds a second command");
    expect(second.message).not.toContain("secret-value");
    expect(second.message.endsWith("Nothing was sent.")).toBe(true);
  });

  test.each([
    ["foo", "metadata-only"],
    ["ge /app/config", "metadata-only"],
    ["compaction 5", "metadata-only"],
    ["defrag", "metadata-only"],
    ["member add m2 --peer-urls=http://m2:2380", "metadata-only"],
    ["snapshot save /tmp/x", "metadata-only"],
    ["user list", "metadata-only"],
    ["lock /app/lock", "metadata-only"],
  ] as const)("%s is a command outside the table, refused with the agent's own sentence", (text, code) => {
    expect(readEtcdAgentStatement(text)).toEqual({ ok: false, code, message: ETCD_AGENT_SENTENCES.metadataOnly });
  });

  test.each([
    "get /app/config --secretflag",
    "get /app/config --print-value-only",
    "get /app/config --endpoints=http://x:2379",
    "get /app/config --prefix --from-key",
    "get /app/config --limit=999999999999",
    "get /app/config --limit=1 --limit=2",
  ])("%s carries a flag the agent's reads do not take, refused with the agent's own sentence", (text) => {
    expect(readEtcdAgentStatement(text)).toEqual({ ok: false, code: "arguments", message: ETCD_AGENT_SENTENCES.flags });
  });

  test("a refusal passed on from the parser ends with the reads the table holds", () => {
    const second = readEtcdAgentStatement("get /app/config\nget /app/other");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toContain("endpoint status, member list, alarm list, auth status, lease list");
      expect(second.message).not.toContain("put");
      expect(second.message).not.toContain("Admin");
    }
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
    expect(ETCD_AGENT_SENTENCES.request("Refused.")).toMatch(
      /^Refused\. Agent mode on etcd reads metadata only: .* Nothing was sent\.$/,
    );
  });
});
