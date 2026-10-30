// Sends the agent boundary plan of one InfluxDB line to the servers its run.sh started, and writes one capture per
// request into <version>/agent-boundary/, in the shape of every other capture of this directory (README.md).
//
//   node tests/fixtures/influxdb/agent-boundary-probe.mjs 1.13.1|2.9.1
//
// The principals' credentials arrive in the environment, generated per run by run.sh: INFLUX_URL (the server with
// authentication on), INFLUX_NOAUTH_URL (1.x only, the same image with authentication off), and per principal
// INFLUX_<NAME>, a Basic user:password on 1.x and a token on 2.x. A capture records the credential's scheme and the
// principal's name and rights, never its value, and the script refuses to write a file that holds any credential, a
// Basic pair's base64 or a password. Every statement is sent raw: no Studio policy stands in front of it, which is the
// point, since what is measured is what the server refuses on its own.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const images = {
  "1.13.1": "influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0",
  "2.9.1": "influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e",
};
if (!(version in images)) throw new Error("usage: agent-boundary-probe.mjs 1.13.1|2.9.1");
const capturedAt = new Date().toISOString().slice(0, 10);
const out = join(here, version, "agent-boundary");
mkdirSync(out, { recursive: true });

/** Every principal of a line: what it may do, as a capture states it, and where its credential comes from. */
const PRINCIPALS = {
  "1.13.1": {
    admin: { rights: "admin", scheme: "basic" },
    reader: { rights: "READ on home", scheme: "basic" },
    rw: { rights: "READ on home, WRITE on other", scheme: "basic" },
    anonymous: { rights: "no credential, authentication on", scheme: "none" },
    "auth-off": { rights: "no credential, authentication off", scheme: "none", server: "noauth" },
  },
  "2.9.1": {
    operator: { rights: "the operator token, all access", scheme: "token" },
    ro: { rights: "read on bucket home", scheme: "token" },
    rwhome: { rights: "read and write on bucket home", scheme: "token" },
    rwother: { rights: "read on bucket home, write on bucket other", scheme: "token" },
    readother: { rights: "read on buckets home and other, write on bucket other", scheme: "token" },
    anonymous: { rights: "no credential", scheme: "none" },
  },
}[version];

const secrets = Object.keys(PRINCIPALS)
  .map((name) => process.env[`INFLUX_${name.toUpperCase().replace("-", "_")}`])
  .filter((value) => value !== undefined && value !== "");
for (const value of [...secrets]) {
  if (value.includes(":")) {
    secrets.push(value.slice(value.indexOf(":") + 1), Buffer.from(value).toString("base64"));
  }
}

function authorization(principal) {
  const { scheme } = PRINCIPALS[principal];
  if (scheme === "none") return {};
  const credential = process.env[`INFLUX_${principal.toUpperCase().replace("-", "_")}`];
  if (!credential) throw new Error(`INFLUX_${principal.toUpperCase()} is not set`);
  return scheme === "basic"
    ? { authorization: `Basic ${Buffer.from(credential).toString("base64")}` }
    : { authorization: `Token ${credential}` };
}

/** One form POST to /query, as the provider's route table sends it, answered whatever its status. */
function query(principal, form, signal) {
  const base = PRINCIPALS[principal].server === "noauth" ? process.env.INFLUX_NOAUTH_URL : process.env.INFLUX_URL;
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const sent = request(
      `${base}/query`,
      {
        method: "POST",
        signal,
        headers: {
          ...authorization(principal),
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            contentType: response.headers["content-type"] ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    sent.on("error", reject);
    sent.end(body);
  });
}

/** An answer with what changes run to run replaced: a running query's id and duration, and a client's address. */
function stable(text) {
  return text
    .replace(/\["[0-9.]+",\d+,/g, '["<client>",<qid>,')
    .replace(/"(\d+(?:\.\d+)?(?:ns|µs|ms|s))","running"/g, '"<duration>","running"')
    .replace(/(execution_time|planning_time|total_time): [0-9.]+(?:ns|µs|ms|s)/g, "$1: <time>");
}

let written = 0;
async function capture(name, principal, form, note) {
  const answer = await query(principal, form);
  const file = {
    version,
    name: `agent-boundary/${name}`,
    image: images[version],
    capturedAt,
    principal: `${principal}: ${PRINCIPALS[principal].rights}`,
    ...(note === undefined ? {} : { note }),
    request: { method: "POST", path: "/query", query: {}, form, auth: PRINCIPALS[principal].scheme },
    status: answer.status,
    contentType: answer.contentType,
    body: stable(answer.body),
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  for (const secret of secrets) {
    if (text.includes(secret)) throw new Error(`${name}: the capture would hold a credential, so nothing was written`);
  }
  writeFileSync(join(out, `${name}.json`), text);
  written += 1;
  console.log(`${name}: ${principal} -> ${answer.status} ${stable(answer.body).slice(0, 160)}`);
  return answer;
}

/** A no-op write: deleting from a measurement no database holds, before any point there can be. */
const NONCE = "libredb_agent_probe";
const writeProbe = `DELETE FROM "${NONCE}" WHERE time < 0`;

if (version === "1.13.1") {
  // The admin read: SHOW USERS needs the admin privilege.
  for (const principal of ["reader", "rw", "admin", "auth-off"]) {
    await capture(`admin-read-${principal}`, principal, { q: "SHOW USERS" });
  }
  await capture("anonymous-refused", "anonymous", { q: "SHOW DATABASES" });
  // The listing the write probe walks: a database the principal may only write is listed too.
  for (const principal of ["reader", "rw"]) {
    await capture(`listing-${principal}`, principal, { q: "SHOW DATABASES" });
  }
  // The no-op write probe, on each database a principal lists.
  await capture("write-probe-reader-home", "reader", { db: "home", q: writeProbe });
  await capture("write-probe-rw-home", "rw", { db: "home", q: writeProbe });
  await capture("write-probe-rw-other", "rw", { db: "other", q: writeProbe });
  await capture("write-probe-admin-home", "admin", { db: "home", q: writeProbe });
  await capture("write-probe-auth-off-home", "auth-off", { db: "home", q: writeProbe });
  // SELECT ... INTO sent past the client policy, into the bound database and into a second one.
  const into = {
    bound: 'SELECT * INTO "home"."autogen"."libredb_into" FROM "home"',
    "bound-unqualified": 'SELECT * INTO "libredb_into" FROM "home"',
    second: 'SELECT * INTO "other"."autogen"."libredb_into" FROM "home"',
    "second-default-rp": 'SELECT * INTO "other".."libredb_into" FROM "home"',
    "second-subquery": 'SELECT * FROM (SELECT * INTO "other".."libredb_into_sub" FROM "home")',
    "second-explain": 'EXPLAIN SELECT * INTO "other".."libredb_into_explain" FROM "home"',
    "second-explain-analyze": 'EXPLAIN ANALYZE SELECT * INTO "other".."libredb_into_analyze" FROM "home"',
  };
  // What each database holds before, after the reader's INTO statements and after the writer's, read as admin.
  const state = async (when) => {
    await capture(`into-state-home-${when}`, "admin", { db: "home", q: "SHOW MEASUREMENTS" });
    await capture(`into-state-other-${when}`, "admin", { db: "other", q: "SHOW MEASUREMENTS" });
  };
  await state("before");
  for (const principal of ["reader", "rw"]) {
    for (const [shape, q] of Object.entries(into)) {
      await capture(`into-${shape}-${principal}`, principal, { db: "home", q });
    }
    await state(`after-${principal}`);
  }
  // The SHOW forms, as the read principal with a database: which ones disclose what others hold or ran.
  const shows = {
    queries: "SHOW QUERIES",
    "continuous-queries": "SHOW CONTINUOUS QUERIES",
    users: "SHOW USERS",
    "grants-admin": "SHOW GRANTS FOR admin",
    "grants-self": "SHOW GRANTS FOR reader",
    stats: "SHOW STATS",
    diagnostics: "SHOW DIAGNOSTICS",
    shards: "SHOW SHARDS",
    "shard-groups": "SHOW SHARD GROUPS",
    subscriptions: "SHOW SUBSCRIPTIONS",
    "kill-query": "KILL QUERY 1",
    "retention-policies": "SHOW RETENTION POLICIES",
    measurements: "SHOW MEASUREMENTS",
    series: "SHOW SERIES",
    "tag-keys": "SHOW TAG KEYS",
    "tag-values": 'SHOW TAG VALUES WITH KEY = "room"',
    "field-keys": "SHOW FIELD KEYS",
    "series-cardinality": "SHOW SERIES CARDINALITY",
    "measurement-cardinality": "SHOW MEASUREMENT EXACT CARDINALITY",
  };
  for (const [shape, q] of Object.entries(shows)) await capture(`show-${shape}-reader`, "reader", { db: "home", q });
  // SHOW QUERIES while the admin runs a heavy read: the reader sees the admin's statement text. The read is dropped
  // once the capture is written, which ends it on the server.
  const stop = new AbortController();
  const heavy = query(
    "admin",
    { db: "home", q: "SELECT count(v) FROM big WHERE time >= 1600000000s AND time < 1600200000s GROUP BY time(1ms)" },
    stop.signal,
  ).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await capture("show-queries-during-admin-read-reader", "reader", { db: "home", q: "SHOW QUERIES" });
  stop.abort();
  await heavy;
} else {
  // The admin statements answer "not implemented" for every token, the operator's included.
  for (const principal of ["ro", "operator"]) {
    await capture(`admin-read-${principal}`, principal, { q: "SHOW USERS" });
  }
  await capture("anonymous-refused", "anonymous", { q: "SHOW DATABASES" });
  // The listing: only the operator token lists the system buckets.
  for (const principal of ["ro", "rwother", "readother", "operator"]) {
    await capture(`listing-${principal}`, principal, { q: "SHOW DATABASES" });
  }
  // The no-op write probe.
  await capture("write-probe-ro-home", "ro", { db: "home", q: writeProbe });
  await capture("write-probe-rwhome-home", "rwhome", { db: "home", q: writeProbe });
  await capture("write-probe-rwother-home", "rwother", { db: "home", q: writeProbe });
  await capture("write-probe-rwother-other", "rwother", { db: "other", q: writeProbe });
  await capture("write-probe-readother-other", "readother", { db: "other", q: writeProbe });
  await capture("write-probe-operator-home", "operator", { db: "home", q: writeProbe });
  // SELECT ... INTO sent past the client policy, into the bound bucket and into a second one.
  const into = {
    bound: 'SELECT * INTO "home"."autogen"."libredb_into" FROM "home"',
    second: 'SELECT * INTO "other"."autogen"."libredb_into" FROM "home"',
    "second-subquery": 'SELECT * FROM (SELECT * INTO "other".."libredb_into_sub" FROM "home")',
  };
  const state = async (when) => {
    await capture(`into-state-home-${when}`, "operator", { db: "home", q: "SHOW MEASUREMENTS" });
    await capture(`into-state-other-${when}`, "operator", { db: "other", q: "SHOW MEASUREMENTS" });
  };
  await state("before");
  for (const principal of ["ro", "rwother", "readother", "operator"]) {
    for (const [shape, q] of Object.entries(into)) {
      await capture(`into-${shape}-${principal}`, principal, { db: "home", q });
    }
  }
  await state("after");
  const shows = {
    queries: "SHOW QUERIES",
    "continuous-queries": "SHOW CONTINUOUS QUERIES",
    "kill-query": "KILL QUERY 1",
    "create-database": "CREATE DATABASE libredb_probe",
    "drop-series": `DROP SERIES FROM "${NONCE}"`,
    "drop-measurement": `DROP MEASUREMENT "${NONCE}"`,
    flux: 'from(bucket: "home") |> range(start: -1h)',
  };
  for (const [shape, q] of Object.entries(shows)) await capture(`show-${shape}-ro`, "ro", { db: "home", q });
}

// How the server reads every comment form and a carriage return: a second statement that only the comment's end
// separates from the first, aimed at an admin statement the read principal is refused, so the answer says whether
// the server reached it.
const reader = version === "1.13.1" ? "reader" : "ro";
const second = version === "1.13.1" ? "SHOW USERS" : "SHOW DATABASES";
const forms = {
  "line-comment-lone-cr": `SHOW MEASUREMENTS -- c\r; ${second}`,
  "line-comment-crlf": `SHOW MEASUREMENTS -- c\r\n; ${second}`,
  "line-comment-lf": `SHOW MEASUREMENTS -- c\n; ${second}`,
  "block-comment": `SHOW MEASUREMENTS /* c */; ${second}`,
  "block-comment-holding-cr": `SHOW MEASUREMENTS /* c\r */; ${second}`,
  "block-comment-nested": `SHOW MEASUREMENTS /* a /* b */ ; ${second} */`,
  "lone-cr-between-tokens": "SHOW\rMEASUREMENTS",
  hash: "SHOW MEASUREMENTS # c",
};
for (const [shape, q] of Object.entries(forms)) await capture(`fence-${shape}`, reader, { db: "home", q });

console.log(`${written} captures written to ${out}`);
