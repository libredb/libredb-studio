/**
 * createAwsSigner, the signing policy for AWS JSON and Query API requests on the text transport: host, content-type,
 * every x-amz-* header and the SHA-256 of the body are signed, the session token is always signed when present, only
 * the path "/" is signed, and only a query already RFC 3986-encoded is signed.
 *
 * It is held three ways. Directly: the nine POST vectors of the AWS SigV4 suite whose signed set is this policy are fed
 * to sign() with the suite's host, clock and keys and reproduce the suite's Authorization; the three POST vectors
 * outside the policy are named with their reasons. Through a real text transport against a loopback listener: the
 * Authorization the listener received equals one recomputed with signatureV4 from what it received, and the clock and
 * the credentials getter are read at send time. And with every ambient AWS variable set to hostile values, a credential
 * resolved and signed signs exactly as without them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAwsCredentials } from "@/lib/db/auth/aws/credentials";
import { createAwsSigner } from "@/lib/db/auth/aws/signer";
import { type AwsCredentials, canonicalQueryOf, EMPTY_PAYLOAD_SHA256, signatureV4 } from "@/lib/db/auth/aws/sigv4";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin, rfc3986Encode, rfc3986Query } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport, type SigningInput } from "@/lib/db/http/node-transport";
import { closeAll, httpListener, jsonAnswer, type Seen } from "../../../../helpers/node-transport-fixtures";

interface SuiteVector {
  readonly name: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string | null | readonly (string | null)[]>>;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  };
  readonly authorization: string;
}

const suite = JSON.parse(readFileSync(join(import.meta.dir, "../../../../fixtures/s3/sigv4-suite.json"), "utf8")) as {
  readonly header: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
    readonly service: string;
    readonly amzDate: string;
  };
  readonly vectors: readonly SuiteVector[];
};
const { header } = suite;
const SUITE_CLOCK = () => new Date("2015-08-30T12:36:00Z");
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The POST vectors whose signed set is the signer's policy: host, content-type and every x-amz-* header. */
const IN_POLICY = [
  "post-header-key-case",
  "post-sts-header-before",
  "post-vanilla",
  "post-vanilla-empty-query-value",
  "post-vanilla-query",
  "post-vanilla-query-nonunreserved",
  "post-vanilla-query-space",
  "post-x-www-form-urlencoded",
  // Signs `content-type: application/x-www-form-urlencoded; charset=utf8`, which the text transport never sends; a
  // direct call signs the content type it is given.
  "post-x-www-form-urlencoded-parameters",
];

/** The POST vectors outside the policy, each with the reason the signer cannot reproduce it. */
const OUTSIDE_POLICY: Readonly<Record<string, string>> = {
  "post-header-key-sort":
    "signs my-header1, a header that is neither content-type nor x-amz-*, which the signer never signs",
  "post-header-value-case":
    "signs my-header1, a header that is neither content-type nor x-amz-*, which the signer never signs",
  "post-sts-header-after": "sends the session token unsigned, while the signer always signs x-amz-security-token",
};

function vector(name: string): SuiteVector {
  const found = suite.vectors.find((one) => one.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
}

/** The query as a caller sends it: each pair encoded, in the vector's order, not sorted. */
function wireQuery(query: SuiteVector["request"]["query"]): string {
  return Object.entries(query)
    .flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((one) => `${rfc3986Encode(name)}=${rfc3986Encode(one ?? "")}`),
    )
    .join("&");
}

/** What a text transport hands the signer for the vector: the vector's headers but the signer's own, and its body. */
function signingInput(one: SuiteVector): SigningInput {
  const headers = Object.fromEntries(
    Object.entries(one.request.headers).filter(([name]) => name !== "x-amz-date" && name !== "x-amz-security-token"),
  );
  return {
    method: "POST",
    host: one.request.headers.host,
    path: one.request.path,
    query: wireQuery(one.request.query),
    headers: { ...headers, "accept-encoding": "identity" },
    body: one.request.body ?? "",
  };
}

function suiteCredentials(one: SuiteVector): AwsCredentials {
  const token = one.request.headers["x-amz-security-token"];
  return {
    accessKeyId: header.accessKeyId,
    secretAccessKey: header.secretAccessKey,
    ...(token === undefined ? {} : { sessionToken: token }),
  };
}

function suiteSigner(credentials: AwsCredentials) {
  return createAwsSigner({
    credentials: () => credentials,
    region: header.region,
    service: header.service,
    clock: SUITE_CLOCK,
  });
}

describe("the AWS SigV4 suite, fed to sign() directly", () => {
  test("the POST vectors are the nine in the policy and the three outside it", () => {
    const posts = suite.vectors.filter((one) => one.request.method === "POST").map((one) => one.name);
    expect(posts.sort()).toEqual([...IN_POLICY, ...Object.keys(OUTSIDE_POLICY)].sort());
    expect(IN_POLICY).toHaveLength(9);
  });

  test.each(IN_POLICY)("%s", (name) => {
    const one = vector(name);
    const credentials = suiteCredentials(one);
    const signed = suiteSigner(credentials).sign(signingInput(one));
    expect(signed).toEqual({
      authorization: one.authorization,
      "x-amz-date": header.amzDate,
      ...(credentials.sessionToken === undefined ? {} : { "x-amz-security-token": credentials.sessionToken }),
    });
  });

  test.each(Object.entries(OUTSIDE_POLICY))("%s is outside the policy: it %s", (name) => {
    const one = vector(name);
    // post-sts-header-after sends the suite's session token, which its fixture lists only on post-sts-header-before.
    const token = vector("post-sts-header-before").request.headers["x-amz-security-token"];
    const credentials =
      name === "post-sts-header-after" ? { ...suiteCredentials(one), sessionToken: token } : suiteCredentials(one);
    const signed = suiteSigner(credentials).sign(signingInput(one));
    expect(signed.authorization).not.toBe(one.authorization);
    if (name === "post-sts-header-after") {
      expect(signed.authorization).toBe(vector("post-sts-header-before").authorization);
    } else {
      expect(signed.authorization).toContain("SignedHeaders=host;x-amz-date, Signature=");
    }
  });
});

describe("the policy", () => {
  const signer = createAwsSigner({
    credentials: () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }),
    region: "us-east-1",
    service: "dynamodb",
    clock: SUITE_CLOCK,
  });
  const base: SigningInput = {
    method: "POST",
    host: "dynamodb.us-east-1.amazonaws.com",
    path: "/",
    query: "",
    headers: {},
    body: "",
  };

  test("lists authorization, x-amz-date and x-amz-security-token", () => {
    expect(signer.headerNames).toEqual(["authorization", "x-amz-date", "x-amz-security-token"]);
  });

  test("signs host, content-type and every x-amz-* header, and no other", () => {
    const body = '{"TableName":"t"}';
    const headers = {
      host: "dynamodb.us-east-1.amazonaws.com",
      "accept-encoding": "identity",
      "content-type": "application/x-amz-json-1.0",
      "content-length": String(body.length),
      "x-amz-target": "DynamoDB_20120810.ListTables",
      "x-amz-user-agent": "studio",
      "user-agent": "studio",
    };
    const { authorization } = signer.sign({ ...base, headers, body });
    expect(authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-target;x-amz-user-agent, Signature=",
    );
    expect(authorization).toBe(
      signatureV4(
        {
          method: "POST",
          canonicalUri: "/",
          canonicalQuery: "",
          headers: {
            "content-type": headers["content-type"],
            host: headers.host,
            "x-amz-date": header.amzDate,
            "x-amz-target": headers["x-amz-target"],
            "x-amz-user-agent": headers["x-amz-user-agent"],
          },
          payloadHash: sha256(body),
        },
        { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        { region: "us-east-1", service: "dynamodb", amzDate: header.amzDate },
      ),
    );
  });

  test("signs the host it is handed, not a host header", () => {
    const signed = signer.sign({ ...base, headers: { host: "other.example" } });
    expect(signed.authorization).toBe(signer.sign(base).authorization);
  });

  test("the empty body signs the empty-payload hash", () => {
    const { authorization } = signer.sign(base);
    expect(authorization).toBe(
      signatureV4(
        {
          method: "POST",
          canonicalUri: "/",
          canonicalQuery: "",
          headers: { host: base.host, "x-amz-date": header.amzDate },
          payloadHash: EMPTY_PAYLOAD_SHA256,
        },
        { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        { region: "us-east-1", service: "dynamodb", amzDate: header.amzDate },
      ),
    );
  });

  test.each(["/x", "", "/%2F", "//", "/?"])("refuses the path %p with an Error, before reading the clock", (path) => {
    let read = 0;
    const counting = createAwsSigner({
      credentials: () => {
        read += 1;
        return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
      },
      region: "us-east-1",
      service: "dynamodb",
      clock: () => {
        read += 1;
        return SUITE_CLOCK();
      },
    });
    let thrown: unknown;
    try {
      counting.sign({ ...base, path });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'The AWS request signer signs only the path "/": the JSON and Query protocols post to it, and any other path would need a second encoding this signer does not implement',
    );
    expect(read).toBe(0);
  });

  test("a query pair with no = is refused by the core", () => {
    expect(() => signer.sign({ ...base, query: "Action" })).toThrow(
      'The request query holds a pair with no "=", so it cannot be signed',
    );
  });

  test.each([
    ["URLSearchParams form encoding", new URLSearchParams({ k: "a~b* c" }).toString()],
    ["a lower-case escape", "k=%7e"],
    ["a bare *", "k=*"],
    ["a raw space", "k=a b"],
    ["a + for a space", "k=a+b"],
    ["an = inside a value", "k=a=b"],
    ["a non-ASCII character", "k=é"],
    ["a truncated escape", "k=%7"],
    ["a form-encoded name", "a+b=c"],
  ])("refuses a query with %s, before reading the clock", (_label, query) => {
    let read = 0;
    const counting = createAwsSigner({
      credentials: () => {
        read += 1;
        return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
      },
      region: "us-east-1",
      service: "dynamodb",
      clock: () => {
        read += 1;
        return SUITE_CLOCK();
      },
    });
    expect(() => counting.sign({ ...base, query })).toThrow(
      "The AWS request signer signs only a query whose every name and value is RFC 3986-encoded, as rfc3986Query builds it: A-Z a-z 0-9 - . _ ~ and upper-case %XX",
    );
    expect(read).toBe(0);
  });

  test("an RFC 3986-encoded query signs as the suite's get-vanilla-query-unreserved", () => {
    const one = vector("get-vanilla-query-unreserved");
    const signed = suiteSigner(suiteCredentials(one)).sign({
      method: "GET",
      host: one.request.headers.host,
      path: "/",
      query: wireQuery(one.request.query),
      headers: {},
      body: "",
    });
    expect(signed.authorization).toBe(one.authorization);
  });
});

describe("refusals when the signer is built", () => {
  const options = {
    credentials: () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }),
    region: "us-east-1",
    service: "dynamodb",
    clock: SUITE_CLOCK,
  };
  const REGION = "The AWS signing region must be 1 to 64 letters, digits, hyphens or underscores";
  const SERVICE =
    "The AWS service name must be a lower-case letter followed by 1 to 62 lower-case letters, digits or hyphens";

  function refusal(run: () => unknown): DatabaseConfigError {
    try {
      run();
    } catch (error) {
      if (error instanceof DatabaseConfigError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test.each([
    "",
    "us-east-1/x",
    "us east 1",
    "us-east-1\n",
    "x".repeat(65),
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  ])("a region outside AWS_SIGNING_REGION, %p, unquoted", (region) => {
    const error = refusal(() => createAwsSigner({ ...options, region }));
    expect(error.message).toBe(REGION);
  });

  test("a region of another partition or an emulator is a signing region", () => {
    for (const region of ["cn-north-1", "local", "garage", "x".repeat(64)]) {
      expect(createAwsSigner({ ...options, region }).headerNames).toHaveLength(3);
    }
  });

  test.each(["", "a", "DynamoDB", "dynamo db", "dynamo/db", "1x", `a${"b".repeat(63)}`])(
    "a malformed service name %p",
    (service) => {
      expect(refusal(() => createAwsSigner({ ...options, service })).message).toBe(SERVICE);
    },
  );

  test("building reads neither the credentials nor the clock", () => {
    let read = 0;
    createAwsSigner({
      credentials: () => {
        read += 1;
        return options.credentials();
      },
      region: "us-east-1",
      service: "dynamodb",
      clock: () => {
        read += 1;
        return SUITE_CLOCK();
      },
    });
    expect(read).toBe(0);
  });
});

describe("through a real text transport", () => {
  const transports: NodeTransport[] = [];
  afterEach(async () => {
    for (const transport of transports.splice(0)) transport.close();
    await closeAll();
  });

  const MIB = 1024 * 1024;

  /** The Authorization recomputed with signatureV4 from the request the listener received. */
  function recomputed(seen: Seen, keys: AwsCredentials, region: string, service: string): string {
    const authorization = String(seen.headers.authorization);
    const names = /SignedHeaders=([^,]+),/.exec(authorization)?.[1].split(";") ?? [];
    const headers = Object.fromEntries(names.map((name) => [name, String(seen.headers[name])]));
    const [path, query = ""] = seen.url.split("?");
    const amzDate = String(seen.headers["x-amz-date"]);
    return signatureV4(
      {
        method: seen.method,
        canonicalUri: path,
        canonicalQuery: canonicalQueryOf(query),
        headers,
        payloadHash: sha256(seen.body),
      },
      keys,
      { region, service, amzDate },
    );
  }

  test("a JSON request carries an Authorization equal to one recomputed from what the server received", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const keys = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      requestHeaderNames: ["x-amz-target"],
      jsonContentType: "application/x-amz-json-1.0",
      signer: createAwsSigner({
        credentials: () => keys,
        region: "us-east-1",
        service: "dynamodb",
        clock: () => new Date("2026-11-15T10:00:00Z"),
      }),
    });
    transports.push(transport);
    await transport.request({
      method: "POST",
      url: endpointUrl(origin, "/"),
      body: '{"Limit":1,"Name":"café"}',
      headers: { "x-amz-target": "DynamoDB_20120810.ListTables" },
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: MIB,
    });
    const [seen] = listener.seen;
    expect(seen.headers["content-type"]).toBe("application/x-amz-json-1.0");
    expect(seen.headers["x-amz-date"]).toBe("20261115T100000Z");
    expect(seen.headers["x-amz-security-token"]).toBeUndefined();
    expect(String(seen.headers.authorization)).toContain(
      "Credential=AKIDEXAMPLE/20261115/us-east-1/dynamodb/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=",
    );
    expect(seen.headers.authorization).toBe(recomputed(seen, keys, "us-east-1", "dynamodb"));
  });

  test("a form request with a query, the clock and the credentials read at send time for each request", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const first = { accessKeyId: "AKIDFIRST", secretAccessKey: "first-secret" };
    const second = {
      accessKeyId: "AKIDSECOND",
      secretAccessKey: "second-secret",
      sessionToken: "T0KEN/+=".repeat(200),
    };
    let credentials: AwsCredentials = first;
    let now = new Date("2026-11-15T10:00:00Z");
    let credentialReads = 0;
    let clockReads = 0;
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      signer: createAwsSigner({
        credentials: () => {
          credentialReads += 1;
          return credentials;
        },
        region: "local",
        service: "sts",
        clock: () => {
          clockReads += 1;
          return now;
        },
      }),
    });
    transports.push(transport);
    expect([credentialReads, clockReads]).toEqual([0, 0]);
    const send = () =>
      transport.request({
        method: "POST",
        url: `${endpointUrl(origin, "/")}?Version=2011-06-15&Action=GetCallerIdentity`,
        form: { Action: "GetCallerIdentity", Version: "2011-06-15" },
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: MIB,
      });

    await send();
    expect([credentialReads, clockReads]).toEqual([1, 1]);
    credentials = second;
    now = new Date("2026-11-15T10:04:59Z");
    await send();
    expect([credentialReads, clockReads]).toEqual([2, 2]);

    const [one, two] = listener.seen;
    expect(one.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(one.headers["x-amz-date"]).toBe("20261115T100000Z");
    expect(one.headers["x-amz-security-token"]).toBeUndefined();
    expect(String(one.headers.authorization)).toContain("Credential=AKIDFIRST/20261115/local/sts/aws4_request");
    expect(one.headers.authorization).toBe(recomputed(one, first, "local", "sts"));

    expect(two.headers["x-amz-date"]).toBe("20261115T100459Z");
    expect(two.headers["x-amz-security-token"]).toBe(second.sessionToken);
    expect(String(two.headers.authorization)).toContain(
      "Credential=AKIDSECOND/20261115/local/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=",
    );
    expect(two.headers.authorization).toBe(recomputed(two, second, "local", "sts"));
  });

  test("a request to a path other than / is refused by the signer and nothing is sent", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      signer: createAwsSigner({
        credentials: () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }),
        region: "us-east-1",
        service: "dynamodb",
        clock: SUITE_CLOCK,
      }),
    });
    transports.push(transport);
    let thrown: unknown;
    try {
      await transport.request({
        method: "POST",
        url: endpointUrl(origin, "/tables"),
        body: "{}",
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: MIB,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toStartWith('The AWS request signer signs only the path "/"');
    expect(listener.seen).toHaveLength(0);
  });

  test("a query with ~, * and a space signs when built with rfc3986Query and is refused when built by endpointUrl", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const keys = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      signer: createAwsSigner({ credentials: () => keys, region: "us-east-1", service: "sts", clock: SUITE_CLOCK }),
    });
    transports.push(transport);
    const send = (url: string) =>
      transport.request({
        method: "POST",
        url,
        form: { Action: "GetCallerIdentity" },
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: MIB,
      });

    await send(`${endpointUrl(origin, "/")}?${rfc3986Query([["k", "a~b* c"]])}`);
    const [seen] = listener.seen;
    expect(seen.url).toBe("/?k=a~b%2A%20c");
    expect(seen.headers.authorization).toBe(
      signatureV4(
        {
          method: "POST",
          canonicalUri: "/",
          canonicalQuery: "k=a~b%2A%20c",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: String(seen.headers.host),
            "x-amz-date": header.amzDate,
          },
          payloadHash: sha256(seen.body),
        },
        keys,
        { region: "us-east-1", service: "sts", amzDate: header.amzDate },
      ),
    );

    let thrown: unknown;
    try {
      await send(endpointUrl(origin, "/", new URLSearchParams({ k: "a~b* c" })));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toStartWith("The AWS request signer signs only a query whose every name");
    expect(listener.seen).toHaveLength(1);
  });
});

describe("ambient AWS variables", () => {
  const AMBIENT = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_EC2_METADATA_DISABLED",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_USE_FIPS_ENDPOINT",
    "AWS_USE_DUALSTACK_ENDPOINT",
    "AWS_STS_REGIONAL_ENDPOINTS",
  ];
  const saved = new Map(AMBIENT.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const input: SigningInput = {
    method: "POST",
    host: "dynamodb.us-east-1.amazonaws.com",
    path: "/",
    query: "",
    headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.ListTables" },
    body: "{}",
  };

  function resolvedAndSigned(): Readonly<Record<string, string>> {
    const credentials = resolveAwsCredentials(
      { accessKeyId: "AKIDTYPED", secretAccessKey: "typed-secret", sessionToken: "typed-token" },
      undefined,
    );
    return createAwsSigner({
      credentials: () => credentials,
      region: "us-east-1",
      service: "dynamodb",
      clock: SUITE_CLOCK,
    }).sign(input);
  }

  test("a credential resolved with every ambient AWS variable set to hostile values signs exactly as without them", () => {
    for (const name of AMBIENT) delete process.env[name];
    const clean = resolvedAndSigned();
    for (const name of AMBIENT)
      process.env[name] = name.endsWith("_URI") ? "http://169.254.170.2/hostile" : "AKIDHOSTILE/1";
    const hostile = resolvedAndSigned();
    expect(hostile).toEqual(clean);
    expect(JSON.stringify(hostile)).not.toContain("HOSTILE");
  });
});
