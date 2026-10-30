/**
 * The agent's reader of one Oxia command: the closed table of metadata reads, each pinned as the whole plan it reads
 * to, and every refusal worded in agent mode's own words with the reads it holds.
 */
import { describe, expect, test } from "bun:test";
import {
  OXIA_AGENT_SENTENCES,
  type OxiaAgentReading,
  readOxiaAgentStatement,
} from "@/lib/db/providers/keyvalue/oxia/agent-statement";

const reads = (text: string): OxiaAgentReading => readOxiaAgentStatement(text);

const READS_SENTENCE_START = "Agent mode on Oxia reads metadata only:";

describe("the reads the table holds", () => {
  test.each([
    ["shards", { op: "shards" }],
    ["oxia client shards", { op: "shards" }],
    ["$ oxia client shards", { op: "shards" }],
    ["get /admin/policies/public", { op: "key metadata", key: "/admin/policies/public" }],
    ["get '/odd/with space'", { op: "key metadata", key: "/odd/with space" }],
    ["oxia client get config", { op: "key metadata", key: "config" }],
    ["get -- -dash", { op: "key metadata", key: "-dash" }],
    ["get ''", { op: "key metadata", key: "" }],
    ["list", { op: "key count" }],
    ["ls", { op: "key count" }],
    ["oxia client list", { op: "key count" }],
  ])("%s", (text, plan) => {
    expect(reads(text)).toEqual({ ok: true, plan } as OxiaAgentReading);
  });
});

describe("a count over a range or prefix the request names", () => {
  // Counting narrower and narrower ranges would spell out key names one character at a time, so only the count of
  // every key in the namespace is a read.
  test.each([
    "list --prefix x",
    "list -s a -e b",
    "list a",
    "list a b",
    "ls /a /z",
    "list --key-min=a",
    "list --key-max=b",
    "list -s/a",
    "list -e b",
    "oxia client list --prefix x",
    "list --index by-name -e /z",
  ])("%s is refused with agent mode's sentence", (text) => {
    expect(reads(text)).toEqual({ ok: false, code: "metadata-only", message: OXIA_AGENT_SENTENCES.rangeCount });
  });

  test("the sentence says why and lists the reads, and the reads offer no bounded count", () => {
    expect(OXIA_AGENT_SENTENCES.rangeCount).toStartWith(
      "A count over a range or prefix the request names is withheld, since counting narrower ranges would reveal key names:",
    );
    expect(OXIA_AGENT_SENTENCES.rangeCount).toContain(READS_SENTENCE_START);
    expect(OXIA_AGENT_SENTENCES.rangeCount.endsWith("Nothing was sent.")).toBe(true);
    for (const sentence of [OXIA_AGENT_SENTENCES.empty, OXIA_AGENT_SENTENCES.flags, OXIA_AGENT_SENTENCES.rangeCount]) {
      expect(sentence).not.toMatch(/--prefix|-s <|MIN|narrower range\./);
    }
  });
});

describe("what the table refuses", () => {
  test.each([
    ["put /a b", "metadata-only"],
    ["delete /a", "metadata-only"],
    ["del /a", "metadata-only"],
    ["delete-range /a /z", "metadata-only"],
    ["notifications", "metadata-only"],
    ["sequence-updates /a", "metadata-only"],
    ["range-scan", "metadata-only"],
    ["scan --prefix /a/", "metadata-only"],
    ["oxia admin list-namespaces", "metadata-only"],
    ["sessions", "metadata-only"],
    ["get -t floor /a", "arguments"],
    ["get --comparison-type=higher /a", "arguments"],
    ["get -p tenant /a", "arguments"],
    ["get --partition-key tenant /a", "arguments"],
    ["get --index by-name /a", "arguments"],
    ["get --hex /a", "arguments"],
    ["get -v /a", "arguments"],
    ["get -vp tenant /a", "arguments"],
    ["get -n other /a", "arguments"],
    ["-n other get /a", "arguments"],
    ["--namespace=default get /a", "arguments"],
    ["-a localhost:6648 get /a", "arguments"],
    ["list -p tenant", "arguments"],
    ["list --limit 5", "arguments"],
    ["list --internal-keys", "arguments"],
    ["list --request-timeout 1s", "arguments"],
    ["list --auth-token not-a-real-token", "arguments"],
    ["shards -n other", "arguments"],
    ["shards now", "arguments"],
  ])("%s is refused (%s)", (text, code) => {
    const reading = reads(text);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.code).toBe(code as "metadata-only" | "arguments");
    expect(reading.message).toContain(code === "arguments" && text.startsWith("shards") ? "" : READS_SENTENCE_START);
    expect(reading.message.endsWith("Nothing was sent.")).toBe(true);
  });

  test("the metadata-only and flag sentences are agent mode's own, with the reads it holds", () => {
    expect(reads("put /a b")).toEqual({
      ok: false,
      code: "metadata-only",
      message: OXIA_AGENT_SENTENCES.metadataOnly,
    });
    expect(reads("get -p t /a")).toEqual({ ok: false, code: "arguments", message: OXIA_AGENT_SENTENCES.flags });
    expect(reads("shards x")).toEqual({ ok: false, code: "arguments", message: OXIA_AGENT_SENTENCES.shards });
    // No editor sentence leaks through: none of them names the oxia CLI or the editor's other commands.
    for (const text of ["put /a b", "range-scan", "get -t floor /a", "notifications"]) {
      const reading = reads(text);
      expect(reading.ok).toBe(false);
      if (reading.ok) continue;
      expect(reading.message).not.toContain("oxia CLI");
      expect(reading.message).not.toContain("console");
    }
  });

  test("an empty request, and one the parser cannot read, end with the reads", () => {
    expect(reads("   ")).toEqual({ ok: false, code: "request", message: OXIA_AGENT_SENTENCES.empty });
    expect(reads("# a comment only")).toEqual({ ok: false, code: "request", message: OXIA_AGENT_SENTENCES.empty });
    const unclosed = reads("get 'open");
    expect(unclosed).toMatchObject({ ok: false, code: "request" });
    if (!unclosed.ok) expect(unclosed.message).toContain(READS_SENTENCE_START);
    const second = reads("get /a; get /b");
    expect(second).toMatchObject({ ok: false, code: "request" });
    const two = reads("get /a /b");
    expect(two).toMatchObject({ ok: false, code: "request" });
    const internal = reads("get __oxia/term");
    expect(internal).toMatchObject({ ok: false, code: "request" });
    if (!internal.ok) expect(internal.message).toContain("__oxia/");
  });

  test("no refusal quotes the key the request named", () => {
    const key = "/tenants/secret-tenant-marker";
    for (const text of [
      `get -t floor ${key}`,
      `get -p ${key} /a`,
      `put ${key} v`,
      `get ${key} ${key}`,
      `list --prefix ${key} -s ${key}`,
      `range-scan --prefix ${key}`,
    ]) {
      const reading = reads(text);
      expect(reading.ok).toBe(false);
      if (!reading.ok)
        expect({ text, quoted: reading.message.includes("secret-tenant-marker") }).toEqual({
          text,
          quoted: false,
        });
    }
  });
});
