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

  test.each([
    [
      "a later flag on the line whose quote carries its value on",
      `cli get pods \u2014token "x --password "${SECRET}\n${SECRET}"`,
      "cli get pods \u2014token ***",
    ],
    [
      "a later flag on the line whose quote carries its value on, after a quoted flag",
      `cli get pods a"--token"b" --password "${SECRET}\n${SECRET}" 'x`,
      'cli get pods a"--token" ***',
    ],
  ])("%s drops the lines after it", (_name, text, masked) => {
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

// A paste from rich text can hide a flag from the word reader, which the console then sends as a name, a type or a
// selector, so the line still reaches history.
describe("maskStatementForHistory: a flag a paste from rich text hides", () => {
  test.each([
    ["a no-break space before the flag", `cli get pods\u00a0--token=${SECRET}`, "cli get pods\u00a0--token ***"],
    [
      "a no-break space before a flag and value",
      `cli get pods\u00a0--token ${SECRET}`,
      "cli get pods\u00a0--token ***",
    ],
    [
      "every space a no-break space",
      `cli\u00a0get\u00a0pods\u00a0--token\u00a0${SECRET}`,
      "cli\u00a0get\u00a0pods\u00a0--token ***",
    ],
    ["an ideographic space before the flag", `cli get pods\u3000--token=${SECRET}`, "cli get pods\u3000--token ***"],
    ["a form feed before the flag", `cli get pods\f--token ${SECRET}`, "cli get pods\f--token ***"],
    ["a zero-width space before the flag", `cli get pods \u200b--token=${SECRET}`, "cli get pods \u200b--token ***"],
    [
      "a zero-width space between the word before and the flag",
      `cli get pods\u200b--token=${SECRET}`,
      "cli get pods\u200b--token ***",
    ],
    ["a byte order mark before the flag", `cli get pods \ufeff--token=${SECRET}`, "cli get pods \ufeff--token ***"],
    ["a zero-width joiner inside the flag", `cli get pods --to\u200dken=${SECRET}`, "cli get pods --to\u200dken ***"],
    ["a soft hyphen inside the flag", `cli get pods --pass\u00adword ${SECRET}`, "cli get pods --pass\u00adword ***"],
    ["an em dash for the two hyphens", `cli get pods \u2014token=${SECRET}`, "cli get pods \u2014token ***"],
    ["an en dash for the two hyphens", `cli get pods \u2013token ${SECRET}`, "cli get pods \u2013token ***"],
    ["two minus signs", `cli get pods \u2212\u2212token=${SECRET}`, "cli get pods \u2212\u2212token ***"],
    ["two fullwidth hyphens", `cli get pods \uff0d\uff0dtoken=${SECRET}`, "cli get pods \uff0d\uff0dtoken ***"],
    ["a flag after a comma in one word", `cli get pods,--token=${SECRET}`, "cli get pods,--token ***"],
    [
      "a flag inside a quoted value",
      `cli get pods -l "app=web --token ${SECRET}"`,
      'cli get pods -l "app=web --token ***',
    ],
    [
      "an error body that quotes the statement",
      `{"error":"unknown flag: --token ${SECRET}"}`,
      '{"error":"unknown flag: --token ***',
    ],
    [
      "a continuation that glues a quoted flag to the word before it",
      `cli get pods\\\n"--token" ${SECRET}`,
      'cli get pods\\\n"--token" ***',
    ],
    [
      "a continuation that glues an escaped flag to the word before it",
      `cli get pods\\\n\\--token ${SECRET}`,
      "cli get pods\\\n\\--token ***",
    ],
    ["an em dash in a refused text", `cli get pods | x \u2014token=${SECRET}`, "cli get pods | x \u2014token ***"],
    [
      "a zero-width space between the flag and its value in a refused text",
      `cli get pods --token\u200b${SECRET} 'x`,
      "cli get pods --token ***",
    ],
    [
      "a zero-width space between the word before and the flag in a refused text",
      `cli get pods\u200b--token=${SECRET} 'x`,
      "cli get pods\u200b--token ***",
    ],
    [
      "a zero-width space between the flag and its value in a comment",
      `cli get pods # --token\u200b${SECRET}`,
      "cli get pods # --token ***",
    ],
    [
      "a zero-width space between the word before and the flag in a comment",
      `cli get pods # x\u200b--token=${SECRET}`,
      "cli get pods # x\u200b--token ***",
    ],
    [
      "a zero-width space between a continued flag and its value",
      `cli get pods\\\n--token\u200b${SECRET}`,
      "cli get pods\\\n--token ***",
    ],
    [
      "a quote between the flag and its value in a comment",
      `cli get pods # --token"${SECRET}"`,
      'cli get pods # --token" ***',
    ],
    [
      "a backslash between the flag and its value in a comment",
      `cli get pods # --token\\${SECRET}`,
      "cli get pods # --token\\ ***",
    ],
    [
      "an empty quoted string between a continued flag and its value",
      `cli get pods\\\n--token""${SECRET}`,
      'cli get pods\\\n--token"" ***',
    ],
    [
      "an empty quoted string between the flag and its value in a refused text",
      `cli get pods --token""${SECRET} 'x`,
      'cli get pods --token"" ***',
    ],
    [
      "a dash between hyphens glued to a word and the flag in a refused text",
      `cli get pods_---\u2011--token=${SECRET} 'x`,
      "cli get pods_---\u2011--token ***",
    ],
    [
      "a dash between hyphens glued to a word and the flag in a comment",
      `cli get pods # x-\u2014--token ${SECRET}`,
      "cli get pods # x-\u2014--token ***",
    ],
    ["a dash between the flag and its value", `cli get pods --token\u2014${SECRET}`, "cli get pods --token ***"],
    [
      "a dash between the flag and its value after a comma",
      `cli get pods,--token\u2014${SECRET}`,
      "cli get pods,--token ***",
    ],
    [
      "a dash between the flag and its value in a comment",
      `cli get pods # --token\u2014${SECRET}`,
      "cli get pods # --token ***",
    ],
    [
      "a dash between the flag and its value in a refused text",
      `cli get pods --password'\u2013 ${SECRET} -n x`,
      "cli get pods --password' ***",
    ],
  ])("%s", (_name, text, masked) => {
    expect(maskStatementForHistory(text, MASK)).toBe(masked);
    expect(maskStatementForHistory(text, MASK)).not.toContain(SECRET);
  });

  test("a single hyphen is not the declared double-hyphen flag", () => {
    expect(maskStatementForHistory("cli get pods -token x", MASK)).toBe("cli get pods -token x");
  });

  test("a cut inside a word another flag already masks keeps the words after it", () => {
    expect(maskStatementForHistory(`cli --token pods\\\n--token=${SECRET} -n shop`, MASK)).toBe(
      "cli --token *** -n shop",
    );
  });
});

// A long s (U+017F) and a Kelvin sign (U+212A) are the letters outside ASCII that case folding maps onto ASCII ones,
// s and k; neither is a character a flag name holds, so one right next to a flag leaves the flag found.
describe("maskStatementForHistory: a letter case folding maps onto ASCII, next to a flag", () => {
  test.each([
    ["a long s after the flag in a comment", `cli get pods # --token\u017f${SECRET}`, "cli get pods # --token ***"],
    [
      "a long s before the flag in a comment",
      `cli get pods # \u017f--token ${SECRET}`,
      "cli get pods # \u017f--token ***",
    ],
    [
      "a Kelvin sign after the flag in a refused text",
      `cli get pods | x --token\u212a${SECRET}`,
      "cli get pods | x --token ***",
    ],
    [
      "a Kelvin sign before the flag in a refused text",
      `cli get pods | \u212a--token ${SECRET}`,
      "cli get pods | \u212a--token ***",
    ],
    [
      "a long s after the flag in an unclosed quote",
      `cli get pods "--token\u017f${SECRET}`,
      'cli get pods "--token ***',
    ],
    [
      "a long s after a flag a continuation glues on",
      `cli get pods\\\n--token\u017f${SECRET}`,
      "cli get pods\\\n--token ***",
    ],
  ])("%s", (_name, text, masked) => {
    expect(maskStatementForHistory(text, MASK)).toBe(masked);
    expect(maskStatementForHistory(text, MASK)).not.toContain(SECRET);
  });
});

describe("maskStatementForHistory: a word that a continuation joins from two flags", () => {
  test.each([
    [
      "a flag the continuation joins to the flag before it",
      `cli get pods --token\\\n--password ${SECRET}`,
      "cli get pods --token\\ *** ***",
    ],
    [
      "a CRLF continuation and a tab before the value",
      `--password\\\r\n--password\t ${SECRET}`,
      "--password\\ ***\t ***",
    ],
    [
      "a joined flag after a comma and a value of its own",
      `cli get pods x,--token=a\\\n--password ${SECRET}`,
      "cli get pods x,--token *** ***",
    ],
    [
      "a joined flag after a flag and its value",
      `cli get pods --token=a\\\n--password ${SECRET}`,
      "cli get pods --token=*** ***",
    ],
  ])("%s takes the next word as the last flag's value", (_name, text, masked) => {
    expect(maskStatementForHistory(text, MASK)).toBe(masked);
    expect(maskStatementForHistory(text, MASK)).not.toContain(SECRET);
  });
});

describe("maskStatementForHistory: a flag with no value after it in its word", () => {
  test.each([
    ["an empty = value", `cli get pods --token= ${SECRET}`, "cli get pods --token= ***"],
    ["an empty quoted = value", `cli get pods --token="" ${SECRET}`, 'cli get pods --token="" ***'],
    ["an empty = value in capitals", `cli get pods --TOKEN= ${SECRET}`, "cli get pods --TOKEN= ***"],
    ["a colon", `cli get pods --token: ${SECRET}`, "cli get pods --token: ***"],
    ["a no-break space", `cli get pods --token\u00a0 ${SECRET}`, "cli get pods --token\u00a0 ***"],
    [
      "a zero-width space inside the quotes",
      `cli get pods "--token\u200b" ${SECRET}`,
      'cli get pods "--token\u200b" ***',
    ],
    [
      "an empty = value on a flag after a no-break space",
      `cli get pods\u00a0--token= ${SECRET}`,
      "cli get pods\u00a0--token= ***",
    ],
    [
      "an empty = value on a flag written with an em dash",
      `cli get pods \u2014token= ${SECRET}`,
      "cli get pods \u2014token= ***",
    ],
    [
      "an empty = value with the value on the continued line",
      `cli get pods --token= \\\n  ${SECRET}`,
      "cli get pods --token= \\\n  ***",
    ],
  ])("%s takes the next word as the value", (_name, text, masked) => {
    expect(maskStatementForHistory(text, MASK)).toBe(masked);
    expect(maskStatementForHistory(text, MASK)).not.toContain(SECRET);
  });

  test("an empty = value with no word after it is kept as typed", () => {
    expect(maskStatementForHistory("cli get pods --token=", MASK)).toBe("cli get pods --token=");
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
    // The stand-in registry holds the two masks above alone, so the shipped kubectl record's own is left out of it.
    kubectl: { ...QUERY_DIALECTS.kubectl, historyMask: undefined },
  };

  test("a registered dialect answers its record's mask", () => {
    expect(historyMaskOf(caps({ queryDialect: "redis" }), declaring)).toEqual({ credentialFlags: ["--token"] });
  });

  test("a dialect whose record declares none, and an engine with no dialect, have no mask", () => {
    expect(historyMaskOf(caps({ queryDialect: "kafka" }), declaring)).toBeUndefined();
    expect(historyMaskOf(caps({ queryLanguage: "sql" }), declaring)).toBeUndefined();
  });

  test("unknown capabilities mask another engine's statement as a command line: altered, never the value", () => {
    const unknown = historyMaskOf(undefined);
    expect(maskStatementForHistory(`SELECT '--password ${SECRET}' AS note`, unknown)).toBe(
      "SELECT --password *** AS note",
    );
    expect(
      maskStatementForHistory(`SELECT *\nFROM t\nWHERE x = '--token ${SECRET}' AND y = 1;\nSELECT 2;`, unknown),
    ).toBe("SELECT *\nFROM t\nWHERE x = '--token ***");
    expect(maskStatementForHistory("SELECT * FROM t -- password reset", unknown)).toBe(
      "SELECT * FROM t -- password reset",
    );
  });

  test("unknown capabilities take every declared flag once, since the dialect is not known yet", () => {
    expect(historyMaskOf(undefined, declaring)).toEqual({ credentialFlags: ["--token", "--password"] });
  });

  test("the shipped registry: kubectl declares its six credential flags, and no other dialect declares a mask", () => {
    const kubectl = {
      credentialFlags: [
        "--token",
        "--password",
        "--client-key",
        "--client-certificate",
        "--from-literal",
        "--docker-password",
      ],
    };
    expect(historyMaskOf(undefined)).toEqual(kubectl);
    for (const dialect of Object.keys(QUERY_DIALECTS) as QueryDialect[]) {
      expect(historyMaskOf(caps({ queryDialect: dialect }))).toEqual(dialect === "kubectl" ? kubectl : undefined);
    }
  });
});
