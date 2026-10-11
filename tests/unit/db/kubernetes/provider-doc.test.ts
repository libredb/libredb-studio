/**
 * `docs/providers/kubernetes.md` quotes sentences, numbers, commands and declarations the provider's own modules own,
 * the shape of the Oxia and Neo4j doc tests: a value copied into prose is true only until the code moves, so every
 * sentence, cap, command row, refused flag and recipe the doc quotes is read back here from the module that owns it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { NAMESPACE_CAP_NOTICE } from "@/lib/db/providers/platform/kubernetes/connect-warnings";
import { KUBERNETES_CONNECTION_SENTENCES } from "@/lib/db/providers/platform/kubernetes/connection-options";
import {
  CONNECTION_FLAGS,
  CREDENTIAL_FLAGS,
  KUBECTL_COMMAND_TABLE,
  KUBECTL_SENTENCES,
  NOT_IN_V1_COMMANDS,
  NOT_READ_ONLY_COMMANDS,
} from "@/lib/db/providers/platform/kubernetes/console/commands";
import { DISCOVERY_FLOOR_SENTENCE, VERSION_FLOOR_SENTENCE } from "@/lib/db/providers/platform/kubernetes/discovery";
import {
  ANONYMOUS_UNAUTHORIZED_SENTENCE,
  anonymousForbiddenSentence,
  requestWords,
  UNAUTHORIZED_SENTENCE,
} from "@/lib/db/providers/platform/kubernetes/errors";
import * as limits from "@/lib/db/providers/platform/kubernetes/limits";
import { KUBERNETES_SAMPLED_FROM } from "@/lib/db/providers/platform/kubernetes/objects";
import { planRequest } from "@/lib/db/providers/platform/kubernetes/request-policy";
import { KUBECONFIG_IMPORT_SENTENCES } from "@/lib/kubernetes/kubeconfig-import";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const DOC = read("docs/providers/kubernetes.md");
const BACKLOG = read("docs/BACKLOG.md");
const AGENT_DOC = read("docs/AGENT.md");

/** A quoted sentence: the doc's blockquote line that holds it whole. */
const quoted = (sentence: string) => DOC.split("\n").includes(`> ${sentence}`);

function sectionOf(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const end = DOC.indexOf("\n## ", start + heading.length + 2);
  return DOC.slice(start, end === -1 ? undefined : end);
}

const count = (value: number) => value.toLocaleString("en-US");
const mib = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;

describe("the sentences the doc quotes are the code's", () => {
  test.each([
    ["the plain HTTP refusal", KUBERNETES_CONNECTION_SENTENCES.plaintextLoopbackOff],
    ["the unchecked certificate refusal", KUBERNETES_CONNECTION_SENTENCES.insecureTlsOff],
    ["the namespace cap notice", NAMESPACE_CAP_NOTICE],
    ["the credential plugin notice", KUBECONFIG_IMPORT_SENTENCES.credentialPlugin],
    ["the no credential notice", KUBECONFIG_IMPORT_SENTENCES.noCredential],
    ["the 401 sentence", UNAUTHORIZED_SENTENCE],
    ["the anonymous 401 sentence", ANONYMOUS_UNAUTHORIZED_SENTENCE],
    ["the anonymous 403 sentence", anonymousForbiddenSentence(planRequest({ op: "discovery", root: "api" }).context)],
    ["the follow refusal", KUBECTL_SENTENCES.follow],
    ["the version floor", VERSION_FLOOR_SENTENCE],
    ["the discovery floor", DISCOVERY_FLOOR_SENTENCE],
  ])("%s", (_name, sentence) => {
    expect(quoted(sentence)).toBe(true);
  });

  test("the error section's examples of a read outside the resource API are the code's words", () => {
    const section = sectionOf("## 10. Error handling");
    for (const request of [{ op: "discovery", root: "api" }, { op: "version" }, { op: "readyz" }] as const)
      expect(section).toContain(`"${requestWords(planRequest(request).context)}"`);
  });

  test("the sampled count says what it was counted from", () => {
    expect(DOC).toContain(`counted from ${KUBERNETES_SAMPLED_FROM}`);
  });
});

describe("the console section is the command table", () => {
  const cell = (text: string) => text.replaceAll("|", "\\|");

  test.each(KUBECTL_COMMAND_TABLE.map((row) => [row.command, row] as const))("kubectl %s", (_command, row) => {
    const args = row.arguments === "" ? "none" : cell(row.arguments);
    const flags = row.flags.length === 0 ? "none" : row.flags.map((flag) => `\`${cell(flag)}\``).join(", ");
    expect(DOC).toContain(`| \`kubectl ${row.command}\` | ${args} | ${flags} |`);
  });

  test("every refused connection flag, command and credential flag is named", () => {
    const querySection = sectionOf("## 5. Query interface");
    for (const flag of CONNECTION_FLAGS) expect(querySection).toContain(`\`${flag}\``);
    for (const command of [...NOT_READ_ONLY_COMMANDS, ...NOT_IN_V1_COMMANDS])
      expect(querySection).toContain(`\`${command}\``);
    expect(querySection).toContain(
      `${CREDENTIAL_FLAGS.slice(0, -1)
        .map((flag) => `\`${flag}\``)
        .join(", ")} and \`${CREDENTIAL_FLAGS.at(-1)}\``,
    );
  });
});

describe("the limits table is limits.ts", () => {
  test.each([
    ["Objects per list request", count(limits.KUBERNETES_PAGE_SIZE)],
    ["Rows one statement reads", count(limits.KUBERNETES_MAX_STATEMENT_ROWS)],
    ["Objects the tree lists per kind and container", count(limits.KUBERNETES_TREE_OBJECT_CAP)],
    ["Bytes per response", mib(limits.KUBERNETES_MAX_RESPONSE_BYTES)],
    ["Nesting of an answer's objects and arrays", `${count(limits.KUBERNETES_MAX_JSON_DEPTH)} levels`],
    ["Bytes per `-o json` or `-o yaml` document", mib(limits.KUBERNETES_MAX_DOCUMENT_BYTES)],
    ["Objects per `-o json` or `-o yaml` statement", count(limits.KUBERNETES_MAX_DOCUMENT_OBJECTS)],
    ["Log lines without `--tail`", count(limits.KUBERNETES_LOG_TAIL_DEFAULT)],
    ["Log lines `--tail` may ask for", count(limits.KUBERNETES_LOG_TAIL_MAX)],
    ["Log lines per pod under `-l` without `--tail`", count(limits.KUBERNETES_LOG_SELECTOR_TAIL)],
    ["Bytes per log stream", mib(limits.KUBERNETES_LOG_LIMIT_BYTES)],
    ["Log streams per statement", count(limits.KUBERNETES_MAX_LOG_STREAMS)],
    ["Watch window without `--request-timeout`", `${limits.KUBERNETES_WATCH_WINDOW_SECONDS} s`],
    ["Bytes per watch window", mib(limits.KUBERNETES_WATCH_WINDOW_BYTES)],
    ["Events `events` reads", count(limits.KUBERNETES_EVENTS_READ_MAX)],
    ["Events `events` shows", count(limits.KUBERNETES_EVENTS_SHOWN)],
    ["Bytes per `explain` document", mib(limits.KUBERNETES_EXPLAIN_DOCUMENT_BYTES)],
    ["Discovery kept per connection", `${limits.KUBERNETES_DISCOVERY_TTL_MS / 60_000} minutes`],
    ["Longest wait on a 429", `${limits.KUBERNETES_RETRY_AFTER_MAX_MS / 1000} s`],
    ["Bytes of a pasted kubeconfig", mib(limits.KUBERNETES_KUBECONFIG_MAX_BYTES)],
    ["Nesting of a pasted kubeconfig", `${count(limits.KUBERNETES_KUBECONFIG_MAX_DEPTH)} levels`],
  ])("%s", (label, value) => {
    expect(DOC).toContain(`| ${label} | ${value} |`);
  });

  test("the default port is the dialog's", () => {
    expect(DB_UI_CONFIG.kubernetes.defaultPort).toBe(String(limits.KUBERNETES_DEFAULT_PORT));
    expect(sectionOf("## 4. Connection")).toContain(`${limits.KUBERNETES_DEFAULT_PORT} by default`);
  });
});

describe("the declarations the doc states", () => {
  test("read-only enforced, and MCP not offered", () => {
    expect(READ_ONLY_ENFORCED.kubernetes).toBe(true);
    expect(MCP_EXPOSABLE.kubernetes).toBe(false);
    expect(sectionOf("## 9. Capabilities, AI and MCP")).toContain("MCP is not offered for Kubernetes");
  });

  test("the studio-reader recipe is the file the throwaway clusters apply", () => {
    const recipe = read("docker/kubernetes/studio-reader.yaml")
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    expect(DOC).toContain(`\`\`\`yaml\n${recipe}\`\`\``);
  });
});

describe("the backlog entries the doc cites exist, and the agent ones are cited by docs/AGENT.md", () => {
  const cited = [...new Set([...sectionOf("## 14. Known limitations").matchAll(/\b([BDU]\d+)\b/g)].map((m) => m[1]))];

  test.each(cited)("%s is an entry of docs/BACKLOG.md", (id) => {
    expect(BACKLOG).toMatch(new RegExp(`^### ${id}\\. `, "m"));
  });

  test("each B-series entry is cited by docs/AGENT.md", () => {
    const agentEntries = cited.filter((id) => id.startsWith("B"));
    expect(agentEntries.length).toBeGreaterThan(0);
    for (const id of agentEntries) expect(AGENT_DOC).toContain(`**${id}**`);
  });
});
