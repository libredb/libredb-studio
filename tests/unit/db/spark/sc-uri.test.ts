import { describe, expect, test } from "bun:test";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import { parseSparkConnectUri, SPARK_PASTE_SENTENCES } from "@/lib/db/providers/sql/spark/sc-uri";

/** A host of 253 characters, the longest the host rules take, in labels short enough that only its length counts. */
const HOST_253 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
/** One character longer, so the length check alone refuses it. */
const HOST_254 = `${HOST_253}d`;

/** The sc:// reader: Spark's documented grammar sc://host[:port][/][;key=value]*, pure and type-only. */
describe("parseSparkConnectUri", () => {
  test("reads the host and the port, 15002 when absent, a bare / after the host accepted", () => {
    expect(parseSparkConnectUri("sc://Spark.Example.Internal:15003")).toEqual({
      type: "spark",
      host: "spark.example.internal",
      port: "15003",
      sslMode: "disable",
    });
    expect(parseSparkConnectUri("  sc://localhost/  ")).toEqual({
      type: "spark",
      host: "localhost",
      port: "15002",
      sslMode: "disable",
    });
    expect(parseSparkConnectUri("sc://10.0.0.7;")).toMatchObject({ host: "10.0.0.7", port: "15002" });
  });

  test("keeps a bracketed IPv6 literal with its brackets", () => {
    expect(parseSparkConnectUri("sc://[::1]:15002")).toMatchObject({ host: "[::1]", port: "15002" });
    expect(parseSparkConnectUri("sc://[FD00::7]")).toMatchObject({ host: "[fd00::7]", port: "15002" });
  });

  test("token fills Token; use_ssl=true turns TLS on and use_ssl=false leaves it to the token rule", () => {
    expect(parseSparkConnectUri("sc://h:1/;use_ssl=true;token=abc")).toEqual({
      type: "spark",
      host: "h",
      port: "1",
      password: "abc",
      sslMode: "verify-system",
    });
    // Spark's 4.2.0 Python and Scala clients use TLS whenever a token is set and the host is not literally localhost.
    expect(parseSparkConnectUri("sc://h;use_ssl=false;token=abc")).toEqual({
      type: "spark",
      host: "h",
      port: "15002",
      password: "abc",
      sslMode: "verify-system",
    });
    expect(parseSparkConnectUri("sc://localhost;use_ssl=false;token=abc").sslMode).toBe("disable");
    expect(parseSparkConnectUri("sc://h;use_ssl=false")).toEqual({
      type: "spark",
      host: "h",
      port: "15002",
      sslMode: "disable",
    });
    expect(parseSparkConnectUri("sc://localhost;use_ssl=true").sslMode).toBe("verify-system");
  });

  test("reads use_ssl=true and use_ssl=false in any case, as Spark's clients do", () => {
    expect(parseSparkConnectUri("sc://h;use_ssl=TRUE")).toEqual({
      type: "spark",
      host: "h",
      port: "15002",
      sslMode: "verify-system",
    });
    expect(parseSparkConnectUri("sc://localhost;use_ssl=True;token=a")).toEqual({
      type: "spark",
      host: "localhost",
      port: "15002",
      password: "a",
      sslMode: "verify-system",
    });
    expect(parseSparkConnectUri("sc://h;use_ssl=FALSE")).toEqual({
      type: "spark",
      host: "h",
      port: "15002",
      sslMode: "disable",
    });
  });

  test("percent-decodes the token, as Spark's clients do", () => {
    expect(parseSparkConnectUri("sc://h;token=a%2Bb%2Fc%3D%3D")).toEqual({
      type: "spark",
      host: "h",
      port: "15002",
      password: "a+b/c==",
      sslMode: "verify-system",
    });
    expect(parseSparkConnectUri("sc://h;token=a+b").password).toBe("a+b");
  });

  test("refuses a token whose percent escape does not decode, clearing the box, filling nothing and never repeating it", () => {
    for (const text of ["sc://h;token=s3cret%zz", "sc://h;token=s3cret%", "sc://h;use_ssl=true;token=s3cret%FF"]) {
      const parsed = parseSparkConnectUri(text);
      expect(parsed).toEqual({ type: "spark", refusal: SPARK_PASTE_SENTENCES.tokenEscape, discardPaste: true });
      expect(JSON.stringify(parsed)).not.toContain("s3cret");
    }
  });

  test("a token without use_ssl means TLS, unless the host is literally localhost, as Spark's clients do", () => {
    expect(parseSparkConnectUri("sc://h;token=abc").sslMode).toBe("verify-system");
    expect(parseSparkConnectUri("sc://localhost;token=abc").sslMode).toBe("disable");
    expect(parseSparkConnectUri("sc://127.0.0.1;token=abc").sslMode).toBe("verify-system");
    expect(parseSparkConnectUri("sc://h;token=").password).toBeUndefined();
    expect(parseSparkConnectUri("sc://h;token=").sslMode).toBe("disable");
  });

  test("names Spark's own parameters it does not apply, and only counts the others", () => {
    const parsed = parseSparkConnectUri(
      "sc://h;user_id=x;user_agent=y;session_id=z;grpc_max_message_size=1;user_id=again;use_ssl=yes;Token=s3cret;flag",
    );
    expect(parsed.notice).toBe(
      "Not applied: user_id, user_agent, session_id, grpc_max_message_size, use_ssl and 2 other parameters. Studio's Apache Spark connection takes the host, the port, token and use_ssl from an sc:// address: it sends one fixed user id, opens a Spark session per request and sets its own message size limit.",
    );
    expect(parsed.notice).not.toContain("s3cret");
    expect(parsed.notice).not.toContain("Token");
    expect(parsed.ignoredParameters).toBeUndefined();
    expect(parsed.unnamedParameters).toBeUndefined();
    expect(parseSparkConnectUri("sc://h;mystery=1").notice).toBe(
      "Not applied: 1 parameter. Studio's Apache Spark connection takes the host, the port, token and use_ssl from an sc:// address: it sends one fixed user id, opens a Spark session per request and sets its own message size limit.",
    );
    expect(parseSparkConnectUri("sc://h;token=a").notice).toBeUndefined();
  });

  test("refuses a Databricks Connect address and clears the box, whatever else it holds", () => {
    const refusal = { type: "spark", refusal: SPARK_PASTE_SENTENCES.databricks, discardPaste: true } as const;
    expect(
      parseSparkConnectUri("sc://adb-1.azuredatabricks.net:443/;token=dapi1;x-databricks-cluster-id=0101"),
    ).toEqual(refusal);
    expect(parseSparkConnectUri("sc://u:p@h/path;x-databricks-cluster-id=1")).toEqual(refusal);
  });

  test("refuses the JDBC form, a path, a missing scheme, a bad host and a bad port, filling nothing", () => {
    const refused = (sentence: string) => ({ type: "spark", refusal: sentence }) as const;
    expect(parseSparkConnectUri("jdbc:sc://h:15002")).toEqual(refused(SPARK_PASTE_SENTENCES.jdbcPrefix));
    expect(parseSparkConnectUri("sc://h:15002/db")).toEqual(refused(SPARK_PASTE_SENTENCES.pathNotEmpty));
    expect(parseSparkConnectUri("sc://h//")).toEqual(refused(SPARK_PASTE_SENTENCES.pathNotEmpty));
    expect(parseSparkConnectUri("h:15002")).toEqual(refused(SPARK_PASTE_SENTENCES.scheme));
    expect(parseSparkConnectUri("sc://")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://bad_host-:1")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://h:1:2")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://[::1")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://[::1]x")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://[fe80::1%eth0]")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://h.123")).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri(`sc://${"a".repeat(254)}`)).toEqual(refused(SPARK_PASTE_SENTENCES.host));
    expect(parseSparkConnectUri("sc://h:0")).toEqual(refused(SPARK_PASTE_SENTENCES.port));
    expect(parseSparkConnectUri("sc://h:65536")).toEqual(refused(SPARK_PASTE_SENTENCES.port));
    expect(parseSparkConnectUri("sc://h:port")).toEqual(refused(SPARK_PASTE_SENTENCES.port));
  });

  /**
   * Every refusal after the Databricks one, by sentence. A text that holds a token parameter (token=, in any case, with
   * or without a value) or a user part (an @ before the first ;) may hold a secret, so the form clears the box; a text
   * that holds neither stays in the box to be corrected.
   */
  const CLEARS_THE_BOX: ReadonlyArray<readonly [string, string]> = [
    ["jdbc:sc://h:15002;token=s3cret", SPARK_PASTE_SENTENCES.jdbcPrefix],
    ["jdbc:sc://h;TOKEN=", SPARK_PASTE_SENTENCES.jdbcPrefix],
    ["jdbc:sc://alice:s3cret@h:15002", SPARK_PASTE_SENTENCES.jdbcPrefix],
    ["h:15002;token=s3cret", SPARK_PASTE_SENTENCES.scheme],
    ["SC://h;Token=s3cret", SPARK_PASTE_SENTENCES.scheme],
    ["alice:s3cret@h:15002", SPARK_PASTE_SENTENCES.scheme],
    ["sc://alice:s3cret@h:15002", SPARK_PASTE_SENTENCES.userInfo],
    ["sc://alice@h;use_ssl=true", SPARK_PASTE_SENTENCES.userInfo],
    ["sc://@h", SPARK_PASTE_SENTENCES.userInfo],
    ["sc://h:15002/db;token=s3cret", SPARK_PASTE_SENTENCES.pathNotEmpty],
    ["sc://h/?token=s3cret", SPARK_PASTE_SENTENCES.pathNotEmpty],
    ["sc://h//;Token=", SPARK_PASTE_SENTENCES.pathNotEmpty],
    ["sc://;token=s3cret", SPARK_PASTE_SENTENCES.host],
    ["sc://bad_host-:1;TOKEN=s3cret", SPARK_PASTE_SENTENCES.host],
    ["sc://h:0;token=s3cret", SPARK_PASTE_SENTENCES.port],
    ["sc://h:port;Token=", SPARK_PASTE_SENTENCES.port],
    ["sc://h;token=s3cret%zz", SPARK_PASTE_SENTENCES.tokenEscape],
  ];

  test.each(CLEARS_THE_BOX)("%s holds a token or a user part: refused, and the box cleared", (text, sentence) => {
    expect(parseSparkConnectUri(text)).toEqual({ type: "spark", refusal: sentence, discardPaste: true });
  });

  /** The edges of the rule: a parameter other than token, an @ inside a parameter, and a bare token with no =. */
  const KEEPS_THE_BOX: ReadonlyArray<readonly [string, string]> = [
    ["jdbc:sc://h;use_ssl=true;user_id=alice@example.com", SPARK_PASTE_SENTENCES.jdbcPrefix],
    ["SC://h;use_ssl=true", SPARK_PASTE_SENTENCES.scheme],
    ["sc://h//;use_ssl=true", SPARK_PASTE_SENTENCES.pathNotEmpty],
    ["sc://bad_host-:1;user_id=alice@example.com", SPARK_PASTE_SENTENCES.host],
    ["sc://h:0;user_id=alice@example.com", SPARK_PASTE_SENTENCES.port],
    ["sc://h:65536;token", SPARK_PASTE_SENTENCES.port],
  ];

  test.each(KEEPS_THE_BOX)("%s holds neither a token nor a user part: refused, and the box kept", (text, sentence) => {
    expect(parseSparkConnectUri(text)).toEqual({ type: "spark", refusal: sentence });
  });

  test("no refusal repeats the text it refuses", () => {
    for (const sentence of Object.values(SPARK_PASTE_SENTENCES)) {
      expect(sentence).not.toContain("alice");
      expect(sentence).not.toContain("dapi1");
    }
  });
});

/**
 * The reader imports types only, so it holds a copy of endpoint.ts's host and port rules, as
 * src/lib/connection-host-uri.ts does. These tests keep the copy from drifting, as
 * tests/unit/lib/connection-host-uri.test.ts does for that one: everything the reader returns passes the Node-side
 * validators unchanged, and everything they refuse the reader refuses too.
 */
describe("parseSparkConnectUri against validateHost and validatePort", () => {
  const ACCEPTED = [
    "sc://Spark.Example.Internal:15003",
    "  sc://localhost/  ",
    "sc://10.0.0.7;",
    "sc://h:1/;use_ssl=true;token=abc",
    "sc://spark_connect:15002",
    "sc://xn--bcher-kva.example:65535",
    "sc://h:08080",
    "sc://[::1]:15002",
    "sc://[FD00::7]",
    "sc://[::ffff:127.0.0.1]:15002",
    `sc://${HOST_253}`,
  ];

  test.each(ACCEPTED)("%s returns a host and port the provider accepts unchanged", (text) => {
    const parsed = parseSparkConnectUri(text);
    expect(parsed.refusal).toBeUndefined();
    expect(validateHost(parsed.host)).toBe(parsed.host as string);
    expect(String(validatePort(parsed.port))).toBe(parsed.port as string);
  });

  const REFUSED_BY_VALIDATE_HOST = [
    "[fe80::1%eth0]",
    // Written in IPv6 characters and still no IPv6 address: URL.canParse refuses these, not the character check.
    "[1:2]",
    "[1.2.3.4]",
    "127.1",
    "0x7f",
    "a.0x10",
    "1.2.3.4.5",
    "bücher.example",
    "１２７.0.0.1",
    "-a.example",
    "a..b",
    `${"a".repeat(64)}.example`,
    `${"a.".repeat(127)}a`,
    HOST_254,
    "under score.example",
  ];

  test.each(REFUSED_BY_VALIDATE_HOST)("%s is refused by validateHost and by the reader", (host) => {
    expect(() => validateHost(host)).toThrow();
    expect(parseSparkConnectUri(`sc://${host}:1`)).toEqual({ type: "spark", refusal: SPARK_PASTE_SENTENCES.host });
  });

  test.each(["0", "65536", "000001", "1.5"])("port %s is refused by validatePort and by the reader", (port) => {
    expect(() => validatePort(port)).toThrow();
    expect(parseSparkConnectUri(`sc://h:${port}`)).toEqual({ type: "spark", refusal: SPARK_PASTE_SENTENCES.port });
  });

  test("a trailing dot, which validateHost accepts, is refused by the reader on purpose", () => {
    expect(validateHost("h.example.")).toBe("h.example.");
    expect(parseSparkConnectUri("sc://h.example.:1")).toEqual({ type: "spark", refusal: SPARK_PASTE_SENTENCES.host });
  });
});
