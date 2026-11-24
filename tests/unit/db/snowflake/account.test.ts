import { describe, expect, test } from "bun:test";
import {
  isSnowflakeHost,
  readSnowflakeAccount,
  isAccountIdentifier,
  SNOWFLAKE_MAX_HOST_LABELS,
  SNOWFLAKE_FIELD_SENTENCES,
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import { snowflakeEndpoint } from "@/lib/db/providers/sql/snowflake/account";
import { SnowflakeError } from "@/lib/db/providers/sql/snowflake/errors";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

describe("readSnowflakeAccount accepts", () => {
  test.each([
    ["myorg-my_account", "myorg-my_account.snowflakecomputing.com", "MYORG-MY_ACCOUNT"],
    ["myorg-my-account", "myorg-my-account.snowflakecomputing.com", "MYORG-MY-ACCOUNT"],
    ["xy12345", "xy12345.snowflakecomputing.com", "XY12345"],
    ["xy12345.us-east-2.aws", "xy12345.us-east-2.aws.snowflakecomputing.com", "XY12345"],
    ["xy12345.us-east-1.privatelink", "xy12345.us-east-1.privatelink.snowflakecomputing.com", "XY12345"],
    ["myorg-myacct.privatelink", "myorg-myacct.privatelink.snowflakecomputing.com", "MYORG-MYACCT"],
    [
      "https://myorg-myacct.privatelink.snowflakecomputing.com",
      "myorg-myacct.privatelink.snowflakecomputing.com",
      "MYORG-MYACCT",
    ],
    ["xy12345.cn-north-1.snowflakecomputing.cn", "xy12345.cn-north-1.snowflakecomputing.cn", "XY12345"],
    ["MyOrg-MyAcct.SnowflakeComputing.com.", "myorg-myacct.snowflakecomputing.com", "MYORG-MYACCT"],
    ["https://myorg-myacct.snowflakecomputing.com/", "myorg-myacct.snowflakecomputing.com", "MYORG-MYACCT"],
    ["https://myorg-myacct.snowflakecomputing.com", "myorg-myacct.snowflakecomputing.com", "MYORG-MYACCT"],
    ["HTTPS://xy12345.cn-north-1.snowflakecomputing.cn/", "xy12345.cn-north-1.snowflakecomputing.cn", "XY12345"],
    ["https://app.snowflake.com/myorg/myacct/worksheets", "myorg-myacct.snowflakecomputing.com", "MYORG-MYACCT"],
    ["https://app.snowflake.com/MyOrg/My_Acct", "myorg-my_acct.snowflakecomputing.com", "MYORG-MY_ACCT"],
    // The region and locator path (SF-020, D341): the locator form, AWS Oregon's without its region.
    ["https://app.snowflake.com/eu-central-1/xy12345/", "xy12345.eu-central-1.snowflakecomputing.com", "XY12345"],
    [
      "https://app.snowflake.com/US-East-2.aws/XY12345/worksheets",
      "xy12345.us-east-2.aws.snowflakecomputing.com",
      "XY12345",
    ],
    ["https://app.snowflake.com/east-us-2.azure/xy12345", "xy12345.east-us-2.azure.snowflakecomputing.com", "XY12345"],
    ["https://app.snowflake.com/us-west-2/xy12345/", "xy12345.snowflakecomputing.com", "XY12345"],
    ["https://app.snowflake.com/us-west-2.aws/xy12345/", "xy12345.snowflakecomputing.com", "XY12345"],
    ["  xy12345  ", "xy12345.snowflakecomputing.com", "XY12345"],
  ])("%s", (text, host, claim) => {
    const reading = readSnowflakeAccount(text);
    expect(reading).toMatchObject({ ok: true, host, accountClaim: claim });
    expect(snowflakeAccountRefusal(text)).toBeUndefined();
  });

  test("a bare identifier and a Snowsight URL carry no URL parts; an account URL carries its own", () => {
    expect(readSnowflakeAccount("xy12345")).toEqual({
      ok: true,
      host: "xy12345.snowflakecomputing.com",
      accountClaim: "XY12345",
      url: null,
    });
    expect(readSnowflakeAccount("https://app.snowflake.com/o/a/x")).toMatchObject({ ok: true, url: null });
    expect(readSnowflakeAccount("https://u:p@xy12345.snowflakecomputing.com:8443/p?q=1#h")).toEqual({
      ok: true,
      host: "xy12345.snowflakecomputing.com",
      accountClaim: "XY12345",
      url: { port: "8443", path: "/p", search: "?q=1", hash: "#h", userinfo: true },
    });
  });
});

describe("readSnowflakeAccount refuses", () => {
  test.each([
    ["", SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
    ["   ", SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
    ["evilsnowflakecomputing.com", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["snowflakecomputing.com.attacker.net", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["snowflakecomputing.com", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://evilsnowflakecomputing.com/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://snowflakecomputing.com.attacker.net/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com/myorg", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com/my.org/acct", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com/eu-central-1/xy_12345/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com/eu-central-1.oracle/xy12345/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    // A Snowsight URL is stored in the public host field, so one carrying a query, a fragment, userinfo or a port is refused.
    ["https://app.snowflake.com/myorg/myacct/worksheets?x=1", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com/myorg/myacct/#y", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://u:p@app.snowflake.com/myorg/myacct", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com:8443/myorg/myacct", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["http://xy12345.snowflakecomputing.com/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["a.b.c.d.e.f", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["xy12345..aws", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["xy 12345", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["app.snowflake.com", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["xy12345.privatelink", SNOWFLAKE_FIELD_SENTENCES.privateLinkRegion],
    ["xy12345.privatelink.snowflakecomputing.com", SNOWFLAKE_FIELD_SENTENCES.privateLinkRegion],
    ["jdbc:snowflake://xy12345.snowflakecomputing.com/?token=S", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["snowflake://u@xy12345/db", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["[::1]", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
  ])("%p", (text, refusal) => {
    expect(readSnowflakeAccount(text)).toEqual({ ok: false, refusal });
  });

  test("the dialog check refuses the two URL forms that belong in Paste URL", () => {
    const format = SNOWFLAKE_FIELD_SENTENCES.accountFormat;
    expect(snowflakeAccountRefusal("jdbc:snowflake://xy12345.snowflakecomputing.com/")).toBe(format);
    expect(snowflakeAccountRefusal("snowflake://u@xy12345/db")).toBe(format);
    expect(snowflakeAccountRefusal("https://evil.example.com/")).toBe(format);
  });
});

describe("readSnowflakeAccount refuses an identifier that still names a Snowflake domain once the suffix is stripped", () => {
  test.each([
    "org-acct.snowflakecomputing.com.snowflakecomputing.com",
    "https://org-acct.snowflakecomputing.com.snowflakecomputing.com/",
    "org-acct.snowflakecomputing.cn.snowflakecomputing.com",
    "xy12345.snowflakecomputing.snowflakecomputing.cn",
    "xy12345.snowflakecomputing",
    "snowflakecomputing",
    "org-snowflakecomputing",
    "app.snowflake.com.snowflakecomputing.com",
    "https://app.snowflake.com.snowflakecomputing.com/",
    "APP.SNOWFLAKE.COM.",
    "snowflake.com",
    "org.snowflake.com.aws",
  ])("%p", (text) => {
    expect(readSnowflakeAccount(text)).toEqual({ ok: false, refusal: SNOWFLAKE_FIELD_SENTENCES.accountFormat });
  });

  test.each([
    // Labels are compared whole: snowflake and com are a Snowflake domain only as two labels of their own.
    ["snowflake.community", "snowflake.community.snowflakecomputing.com", "SNOWFLAKE"],
    ["mysnowflake.com", "mysnowflake.com.snowflakecomputing.com", "MYSNOWFLAKE"],
    ["snowflake-com", "snowflake-com.snowflakecomputing.com", "SNOWFLAKE-COM"],
    ["myorg-snowflake", "myorg-snowflake.snowflakecomputing.com", "MYORG-SNOWFLAKE"],
  ])("but reads %p, whose labels name no Snowflake domain", (text, host, claim) => {
    expect(readSnowflakeAccount(text)).toMatchObject({ ok: true, host, accountClaim: claim });
  });
});

describe("the field sentences", () => {
  test("each ends with Nothing was sent.", () => {
    for (const sentence of Object.values(SNOWFLAKE_FIELD_SENTENCES))
      expect(sentence.endsWith("Nothing was sent.")).toBe(true);
    expect(SNOWFLAKE_FIELD_SENTENCES).toEqual({
      accountEmpty: "Enter Account: an account identifier such as myorg-myaccount, or its URL. Nothing was sent.",
      accountFormat:
        "Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.",
      privateLinkRegion:
        "A PrivateLink account locator needs its region, such as xy12345.us-east-1.privatelink. Nothing was sent.",
      userEmpty: "Enter the user's login name. Nothing was sent.",
      roleEmpty: "Enter the role every statement runs as. Nothing was sent.",
      keyEmpty: "Paste the private key for key-pair sign-in. Nothing was sent.",
      tokenEmpty: "Enter the programmatic access token. Nothing was sent.",
      method: "Choose Key pair or Programmatic access token for Sign-in. Nothing was sent.",
    });
  });
});

describe("the host test and the hint", () => {
  test("the label bound", () => {
    expect(SNOWFLAKE_MAX_HOST_LABELS).toBe(5);
  });
  test("isSnowflakeHost", () => {
    expect(isSnowflakeHost("myorg-a.snowflakecomputing.com")).toBe(true);
    expect(isSnowflakeHost("A.B.SNOWFLAKECOMPUTING.CN.")).toBe(true);
    expect(isSnowflakeHost("a.b.c.d.e.snowflakecomputing.com")).toBe(true);
    expect(isSnowflakeHost("snowflakecomputing.com")).toBe(false);
    expect(isSnowflakeHost(".snowflakecomputing.com")).toBe(false);
    expect(isSnowflakeHost("a..snowflakecomputing.com")).toBe(false);
    expect(isSnowflakeHost("evilsnowflakecomputing.com")).toBe(false);
    expect(isSnowflakeHost("a.b.c.d.e.f.snowflakecomputing.com")).toBe(false);
    expect(isSnowflakeHost("snowflakecomputing.com.attacker.net")).toBe(false);
  });
  test("the hint names the derived host once the text reads", () => {
    expect(snowflakeHostHint("myorg-myacct")).toBe("Studio connects to myorg-myacct.snowflakecomputing.com.");
    expect(snowflakeHostHint("jdbc:x")).toBeUndefined();
    expect(snowflakeHostHint("")).toBeUndefined();
  });
  test("the identity of an account: one account however it is spelled, the text itself when it does not read", () => {
    expect(snowflakeHostIdentity("myorg-myacct")).toBe("myorg-myacct.snowflakecomputing.com");
    expect(snowflakeHostIdentity(" https://MYORG-MYACCT.snowflakecomputing.com/ ")).toBe(
      "myorg-myacct.snowflakecomputing.com",
    );
    expect(snowflakeHostIdentity(" JDBC:X ")).toBe("jdbc:x");
  });
});

describe("snowflakeEndpoint", () => {
  test("builds https on 443 from the reading", () => {
    expect(snowflakeEndpoint("myorg-myacct", ALLOWS_PRIVATE_HOSTS)).toEqual({
      origin: { scheme: "https", host: "myorg-myacct.snowflakecomputing.com", port: 443 },
      host: "myorg-myacct.snowflakecomputing.com",
      accountClaim: "MYORG-MYACCT",
    });
  });

  test("builds the same endpoint under a blocking and an allowing egress decision, since the account rule admits no address literal", () => {
    for (const account of ["myorg-myacct", "https://xy12345.cn-north-1.snowflakecomputing.cn"]) {
      expect(snowflakeEndpoint(account, BLOCKS_PRIVATE_HOSTS)).toEqual(
        snowflakeEndpoint(account, ALLOWS_PRIVATE_HOSTS),
      );
    }
  });

  test.each([
    ["https://myorg-a.snowflakecomputing.com:443/", "myorg-a.snowflakecomputing.com"],
    ["https://xy12345.cn-north-1.snowflakecomputing.cn", "xy12345.cn-north-1.snowflakecomputing.cn"],
    ["https://app.snowflake.com/myorg/myacct/worksheets", "myorg-myacct.snowflakecomputing.com"],
  ])("accepts %p", (account, host) => {
    expect(snowflakeEndpoint(account, ALLOWS_PRIVATE_HOSTS).origin).toEqual({ scheme: "https", host, port: 443 });
  });

  test.each([
    ["https://myorg-a.snowflakecomputing.com:8443/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://myorg-a.snowflakecomputing.com/x", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://myorg-a.snowflakecomputing.com/?token=S", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://myorg-a.snowflakecomputing.com/#f", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://user@myorg-a.snowflakecomputing.com/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://:pw@myorg-a.snowflakecomputing.com/", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["10.0.0.1", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["10.0.0.1.snowflakecomputing.com", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["[::1]", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["evilsnowflakecomputing.com", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["snowflakecomputing.com.attacker.net", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["a.b.c.d.e.f", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["-myorg-a", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["https://app.snowflake.com/myorg/myacct/worksheets?x=1#y", SNOWFLAKE_FIELD_SENTENCES.accountFormat],
    ["xy12345.privatelink", SNOWFLAKE_FIELD_SENTENCES.privateLinkRegion],
    ["", SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
    [7, SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
    [undefined, SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
  ])("refuses %p before any socket", (account, sentence) => {
    let thrown: unknown;
    try {
      snowflakeEndpoint(account, ALLOWS_PRIVATE_HOSTS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SnowflakeError);
    expect(thrown).toMatchObject({ category: "config", message: sentence });
  });

  test("a refused token-bearing URL does not echo the token", () => {
    const marker = crypto.randomUUID();
    const account = `https://myorg-a.snowflakecomputing.com/?token=${marker}`;
    expect(() => snowflakeEndpoint(account, ALLOWS_PRIVATE_HOSTS)).toThrow(SnowflakeError);
    try {
      snowflakeEndpoint(account, ALLOWS_PRIVATE_HOSTS);
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });
});

describe("the Account hint, the dialog's check and connect() agree on every text (SF-025)", () => {
  const LONG_LABEL = "a".repeat(64);
  const texts = [
    "myorg-myacct",
    "  myorg-myacct ",
    "\tmyorg-myacct\n",
    "https://myorg-myacct.snowflakecomputing.com",
    "https://myorg-myacct.snowflakecomputing.com/",
    "https://myorg-myacct.snowflakecomputing.com:443/",
    "https://myorg-myacct.snowflakecomputing.com:8443",
    "https://myorg-myacct.snowflakecomputing.com/console",
    "https://myorg-myacct.snowflakecomputing.com/?x=1",
    "https://myorg-myacct.snowflakecomputing.com/#f",
    "https://u:pw@myorg-myacct.snowflakecomputing.com",
    "https://app.snowflake.com/myorg/myacct/worksheets",
    "1.2.3.4",
    "169.254.169.254",
    "10.0.0.1.snowflakecomputing.com",
    "-zzlibredb",
    "zzlibredb-",
    "myorg.-x",
    LONG_LABEL,
    "a".repeat(63),
    `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}`,
    "xy12345.privatelink",
    "jdbc:snowflake://myorg-myacct.snowflakecomputing.com",
    "",
    "   ",
  ];

  test.each(texts)("%p", (text) => {
    let endpointRefusal: string | undefined;
    try {
      snowflakeEndpoint(text, ALLOWS_PRIVATE_HOSTS);
    } catch (error) {
      endpointRefusal = (error as Error).message;
    }
    expect(snowflakeAccountRefusal(text)).toBe(endpointRefusal);
    expect(snowflakeHostHint(text) === undefined).toBe(endpointRefusal !== undefined);
  });

  test("the texts the report found hinted are refused by all three, and a padded account is accepted by all three", () => {
    for (const text of [
      "https://myorg-myacct.snowflakecomputing.com:8443",
      "https://myorg-myacct.snowflakecomputing.com/console",
      "https://myorg-myacct.snowflakecomputing.com/?x=1",
      "https://u:pw@myorg-myacct.snowflakecomputing.com",
      "1.2.3.4",
      "169.254.169.254",
      "-zzlibredb",
      LONG_LABEL,
    ]) {
      expect(snowflakeHostHint(text)).toBeUndefined();
      expect(snowflakeAccountRefusal(text)).toBe(SNOWFLAKE_FIELD_SENTENCES.accountFormat);
    }
    expect(snowflakeHostHint("  myorg-myacct ")).toBe("Studio connects to myorg-myacct.snowflakecomputing.com.");
    expect(snowflakeAccountRefusal("  myorg-myacct ")).toBeUndefined();
  });
});

describe("isAccountIdentifier (SF-028)", () => {
  test.each([
    "xy12345",
    "myorg-myacct",
    "myorg-my_acct",
    "xy12345.eu-central-1",
    "xy12345.us-central1.gcp",
    "xy12345.us-east-2.aws",
    "xy12345.east-us-2.azure.privatelink",
    "myorg-myacct.privatelink",
    "XY12345.EU-CENTRAL-1.",
  ])("%s is an account identifier", (text) => {
    expect(isAccountIdentifier(text)).toBe(true);
  });

  test.each([
    "attacker.com",
    "evil.example.org",
    "xy12345.aws",
    "xy12345.eu-central-1.oracle",
    "xy12345.privatelink.aws",
    "my acct",
    "",
  ])("%s is not", (text) => {
    expect(isAccountIdentifier(text)).toBe(false);
  });
});
