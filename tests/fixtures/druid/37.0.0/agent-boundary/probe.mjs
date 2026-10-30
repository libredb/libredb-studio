// Runs each step of a .json capture plan against one Druid Router and prints each step beside the server's answer.
// Usage: DRUID_ADMIN_PASSWORD=... DRUID_USER_PASSWORD=... node probe.mjs <router-url> <plan.json>
//
// A step is one of:
//   { "as": "<user>", "sql": { "query": "...", ... } }               a POST /druid/v2/sql body; with "timed": true,
//                                                                    the seconds it took are printed, rounded
//   { "as": "<user>", "rest": "GET /path" }                          any other request, "body" as JSON when given
//   { "as": "<user>", "race": { "query": ... }, "cancelAfterMs": n,  a POST /druid/v2/sql whose context names a
//     "cancelAs": "<user>" }                                         sqlQueryId, and a DELETE of that id after n ms
//   { "note": "..." }                                                a line printed as it is
//   { "sleep": <ms> }                                                a wait, printed
// The user "anonymous" sends no Authorization header; "admin" signs in with DRUID_ADMIN_PASSWORD and every other user
// with DRUID_USER_PASSWORD. A body value "@PASSWORD@" is replaced with DRUID_USER_PASSWORD. The passwords are generated
// per run by run.sh and never printed: a body's password prints as a label, and an answer's volatile parts (host
// addresses, task ids, timings) and a credential's salt and hash are replaced with labels. The query id headers are printed, since what the server does
// with the id a request names is part of what is measured.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: the captures record what the server holds then.
import { readFileSync } from "node:fs";

const [router, file] = process.argv.slice(2);
const adminPassword = process.env.DRUID_ADMIN_PASSWORD ?? "";
const userPassword = process.env.DRUID_USER_PASSWORD ?? "";
const auth = (user) =>
  user === "anonymous"
    ? {}
    : {
        authorization: `Basic ${Buffer.from(`${user}:${user === "admin" ? adminPassword : userPassword}`).toString("base64")}`,
      };
const cut = (text) => (text.length > 1600 ? `${text.slice(0, 1600)} ...(${text.length} chars)` : text);

/** An answer with the parts that change run to run replaced, so two runs differ only where the server did. */
function shown(text) {
  return cut(
    text
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/g, "<host:port>")
      .replace(/"(?:query_[0-9a-f-]{36}|[a-z_]+_\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/g, '"<task id>"')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
      .replace(/"(salt|hash)":"[^"]*"/g, '"$1":"(withheld)"')
      .replace(/"host":"[0-9a-f]{12}"/g, '"host":"<container>"'),
  );
}

/** The request body as printed: a password field prints as a label. */
function printed(body) {
  return JSON.stringify(body, (key, value) => (value === "@PASSWORD@" ? "(generated)" : value));
}

function sent(body) {
  return JSON.stringify(body, (key, value) => (value === "@PASSWORD@" ? userPassword : value));
}

async function post(user, body) {
  const response = await fetch(`${router}/druid/v2/sql`, {
    method: "POST",
    headers: { ...auth(user), "content-type": "application/json" },
    body: sent(body),
  });
  const id = response.headers.get("x-druid-sql-query-id");
  return `${response.status}${id === null ? "" : ` (query id ${shown(id)})`} ${shown(await response.text())}`;
}

for (const step of JSON.parse(readFileSync(file, "utf8"))) {
  if (step.note !== undefined) {
    console.log(`# ${step.note}`);
    continue;
  }
  if (step.sleep !== undefined) {
    console.log(`(waited ${step.sleep} ms)`);
    await new Promise((resolve) => setTimeout(resolve, step.sleep));
    continue;
  }
  if (step.sql !== undefined) {
    console.log(`> as ${step.as}: POST /druid/v2/sql ${printed(step.sql)}`);
    const started = Date.now();
    const answer = await post(step.as, step.sql);
    console.log(`  ${step.timed ? `after about ${Math.round((Date.now() - started) / 1000)} s: ` : ""}${answer}`);
    continue;
  }
  if (step.race !== undefined) {
    console.log(`> as ${step.as}: POST /druid/v2/sql ${printed(step.race)}`);
    const started = Date.now();
    const answer = post(step.as, step.race).then((text) => ({ text, ms: Date.now() - started }));
    await new Promise((resolve) => setTimeout(resolve, step.cancelAfterMs));
    const id = encodeURIComponent(step.race.context.sqlQueryId);
    console.log(`> as ${step.cancelAs}, after ${step.cancelAfterMs} ms: DELETE /druid/v2/sql/${id}`);
    const cancel = await fetch(`${router}/druid/v2/sql/${id}`, { method: "DELETE", headers: auth(step.cancelAs) });
    console.log(`  ${cancel.status} ${shown(await cancel.text())}`);
    const { text, ms } = await answer;
    console.log(
      `  the statement answered about ${Math.round((ms - step.cancelAfterMs) / 1000)} s after the cancel: ${text}`,
    );
    continue;
  }
  const [method, path] = step.rest.split(" ");
  console.log(`> as ${step.as}: ${step.rest}${step.body === undefined ? "" : ` ${printed(step.body)}`}`);
  const response = await fetch(`${router}${path}`, {
    method,
    headers: { ...auth(step.as), ...(step.body === undefined ? {} : { "content-type": "application/json" }) },
    body: step.body === undefined ? undefined : sent(step.body),
  });
  console.log(`  ${response.status} ${shown(await response.text())}`);
}
