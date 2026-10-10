import { describe, expect, test } from "bun:test";
import { historyMaskOf, maskStatementForHistory } from "@/lib/history-mask";
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

/** The flags a console that refuses credentials would declare; the values below are planted markers. */
const MASK = { credentialFlags: ["--token", "--password", "--client-key", "--client-certificate"] };
const SECRET = "s3cr3t-marker";

const caps = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  queryLanguage: "json",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  schemaRefreshPattern: "",
  defaultPort: null,
  ...overrides,
});

describe("maskStatementForHistory: a text that reads as one command line", () => {
  test.each([
    ["--flag=value", `cli get pods --token=${SECRET}`, "cli get pods --token=***"],
    ["--flag value", `cli get pods --token ${SECRET} -n shop`, "cli get pods --token *** -n shop"],
    ["a double-quoted value after =", `cli get pods --token="${SECRET} two"`, "cli get pods --token=***"],
    ["a single-quoted separate value", `cli get pods --password '${SECRET} two'`, "cli get pods --password ***"],
    ["the whole flag quoted", `cli get pods "--client-key=${SECRET}"`, "cli get pods --client-key=***"],
    ["a quoted flag name", `cli get pods '--token' ${SECRET}`, "cli get pods '--token' ***"],
    [
      "two flags",
      `cli get pods --password ${SECRET} --client-certificate=/home/${SECRET}.crt`,
      "cli get pods --password *** --client-certificate=***",
    ],
    [
      "a value on the continued line",
      `cli get pods \\\n  --token \\\n  ${SECRET}`,
      "cli get pods \\\n  --token \\\n  ***",
    ],
    ["a CRLF ending kept", `cli get pods --token ${SECRET}\r\n`, "cli get pods --token ***\r\n"],
    ["a flag repeated as its own value", `cli get pods --token --token=${SECRET}`, "cli get pods --token ***"],
    ["a flag in a comment after the command", `cli get pods # --token=${SECRET}`, "cli get pods # --token ***"],
    ["a flag in a comment line after the command", `cli get pods\n# --token ${SECRET}`, "cli get pods\n# --token ***"],
    [
      "a flag on the command and one in a later comment",
      `cli get pods --token ${SECRET}\n# --password=${SECRET} |`,
      "cli get pods --token ***\n# --password ***",
    ],
    [
      "a no-break space between flag and value",
      `cli get pods --token\u00a0${SECRET} -n x`,
      "cli get pods --token *** -n x",
    ],
    ["a colon between flag and value", `cli get pods --token:${SECRET}`, "cli get pods --token ***"],
    ["a flag in capitals with =", `cli get pods --TOKEN=${SECRET}`, "cli get pods --TOKEN ***"],
    ["a flag in capitals with a separate value", `cli get pods --TOKEN ${SECRET}`, "cli get pods --TOKEN ***"],
    ["a quoted flag and value in one word", `cli get pods "--token ${SECRET}"`, "cli get pods --token ***"],
    [
      "a continuation that glues the flag to the word before it",
      `cli get pods\\\n--token ${SECRET}`,
      "cli get pods\\\n--token ***",
    ],
    [
      "a continuation that glues a flag and its value to the word before it",
      `cli get pods\\\n--token:${SECRET}`,
      "cli get pods\\\n--token ***",
    ],
  ])("%s", (_name, text, masked) => {
    expect(maskStatementForHistory(text, MASK)).toBe(masked);
    expect(maskStatementForHistory(text, MASK)).not.toContain(SECRET);
  });

  test.each([
    ["a longer flag that starts with a declared one", "cli get pods --tokenfile=/tmp/a"],
    ["a declared flag as another flag's value", "cli get pods --namespace=--token"],
    ["a declared flag with no value after it", "cli get pods --token"],
    ["no declared flag at all", "cli get pods -n shop -o wide"],
    ["a comment naming no declared flag", "cli get pods # --tokenfile is elsewhere"],
  ])("%s is kept as typed", (_name, text) => {
    expect(maskStatementForHistory(text, MASK)).toBe(text);
  });
});

describe("maskStatementForHistory: a text the shell reader refuses", () => {
  test.each([
    ["a $ in the value", `cli get pods --token=${SECRET}$x -n shop`, "cli get pods --token ***"],
    ["an unclosed quote", `cli get pods --token "${SECRET}`, "cli get pods --token ***"],
    [
      "two commands, each masked from its first flag",
      `cli get pods --token ${SECRET} -n a\ncli get ns --password=${SECRET}`,
      "cli get pods --token ***\ncli get ns --password ***",
    ],
    [
      "a quote opened after the flag that closes on a later line",
      `cli get pods --token "${SECRET}\n${SECRET}" | head`,
      "cli get pods --token ***",
    ],
    [
      "a backslash that carries the value to the next line",
      `cli get pods | head --token \\\n${SECRET}`,
      "cli get pods | head --token ***",
    ],
    ["a flag glued to a pipe", `cli get pods|--token ${SECRET}`, "cli get pods|--token ***"],
    ["a flag glued to a semicolon", `cli get pods;--token=${SECRET}`, "cli get pods;--token ***"],
    ["a flag inside a command substitution", `cli get pods $(--token ${SECRET})`, "cli get pods $(--token ***"],
    ["a flag inside backquotes", `cli get pods \`--token ${SECRET}\``, "cli get pods `--token ***"],
    ["a flag glued to a redirection", `cli get pods >--token ${SECRET}`, "cli get pods >--token ***"],
    ["a flag name joined from quoted parts", `cli get pods --to"ken"=${SECRET} 'x`, `cli get pods --to"ken" ***`],
    ["a flag name joined by a backslash", `cli get pods --to\\ken=${SECRET} 'x`, "cli get pods --to\\ken ***"],
    [
      "an escaped double quote inside the value that carries it to the next line",
      `cli get pods --token="${SECRET}\\"\n${SECRET}" 'x`,
      "cli get pods --token ***",
    ],
    ["a no-break space in a refused text", `cli get pods --token\u00a0${SECRET} 'x`, "cli get pods --token ***"],
  ])("%s", (_name, text, masked) => {
    expect(maskStatementForHistory(text, MASK)).toBe(masked);
    expect(maskStatementForHistory(text, MASK)).not.toContain(SECRET);
  });

  test("a refused text with no declared flag is kept as typed", () => {
    expect(maskStatementForHistory("cli get pods | head", MASK)).toBe("cli get pods | head");
  });

  test("a declared flag inside a longer word is not taken for the flag", () => {
    expect(maskStatementForHistory("get pods | x --tokenfile=a", MASK)).toBe("get pods | x --tokenfile=a");
    expect(maskStatementForHistory("get pods | x a--token b", MASK)).toBe("get pods | x a--token b");
  });
});

describe("maskStatementForHistory: no mask", () => {
  test("no mask, or one naming no flag, keeps the text as typed", () => {
    const text = `SELECT 1 --token ${SECRET}`;
    expect(maskStatementForHistory(text, undefined)).toBe(text);
    expect(maskStatementForHistory(text, { credentialFlags: [] })).toBe(text);
  });
});

describe("historyMaskOf", () => {
  const declaring: Readonly<Record<QueryDialect, DialectSpec>> = {
    ...QUERY_DIALECTS,
    redis: { ...QUERY_DIALECTS.redis, historyMask: { credentialFlags: ["--token"] } },
    etcd: { ...QUERY_DIALECTS.etcd, historyMask: { credentialFlags: ["--token", "--password"] } },
  };

  test("a registered dialect answers its record's mask", () => {
    expect(historyMaskOf(caps({ queryDialect: "redis" }), declaring)).toEqual({ credentialFlags: ["--token"] });
  });

  test("a dialect whose record declares none, and an engine with no dialect, have no mask", () => {
    expect(historyMaskOf(caps({ queryDialect: "kafka" }), declaring)).toBeUndefined();
    expect(historyMaskOf(caps({ queryLanguage: "sql" }), declaring)).toBeUndefined();
  });

  test("unknown capabilities take every declared flag once, since the dialect is not known yet", () => {
    expect(historyMaskOf(undefined, declaring)).toEqual({ credentialFlags: ["--token", "--password"] });
  });

  test("the shipped registry declares no mask, so no stored statement changes until a dialect declares one", () => {
    expect(historyMaskOf(undefined)).toBeUndefined();
    for (const dialect of Object.keys(QUERY_DIALECTS) as QueryDialect[]) {
      expect(historyMaskOf(caps({ queryDialect: dialect }))).toBeUndefined();
    }
  });
});
