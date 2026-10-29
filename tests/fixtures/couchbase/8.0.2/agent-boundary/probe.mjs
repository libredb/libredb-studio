// Runs each step of a .json capture plan against one Couchbase node and prints each step beside the server's answer.
// Usage: CB_ADMIN_PASSWORD=... CB_USER_PASSWORD=... node probe.mjs <host> <plan.json>
//
// A step is one of:
//   { "as": "<user>", "rest": "GET /whoami" }                                 a management request on port 8091
//   { "as": "<user>", "rest": "PUT /settings/...", "form": { "k": "v" } }      the same, with a form body
//   { "as": "<user>", "query": { "statement": "...", ... } }                    a POST /query/service body on port 8093
//   { "note": "..." }                                                           a line printed as it is
//   { "sleep": <ms> }                                                           a wait, printed
// The user "Administrator" signs in with CB_ADMIN_PASSWORD and every other user with CB_USER_PASSWORD. A form value
// "@PASSWORD@" is replaced with CB_USER_PASSWORD. The passwords are generated per run by run.sh and never printed:
// a form's password field prints as a label, and an answer's volatile fields (request ids, timings) are dropped.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: the captures record what the server holds then.
import { readFileSync } from "node:fs";

const [host, file] = process.argv.slice(2);
const adminPassword = process.env.CB_ADMIN_PASSWORD ?? "";
const userPassword = process.env.CB_USER_PASSWORD ?? "";
const auth = (user) =>
  `Basic ${Buffer.from(`${user}:${user === "Administrator" ? adminPassword : userPassword}`).toString("base64")}`;
const cut = (text) => (text.length > 1600 ? `${text.slice(0, 1600)} ...(${text.length} chars)` : text);

function scrubbed(value) {
  if (Array.isArray(value)) return value.map(scrubbed);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (["requestID", "elapsedTime", "executionTime", "serviceLoad", "clientContextID"].includes(key)) continue;
    if (/^(?:password|passwordHash|salt)$/i.test(key)) {
      out[key] = "(withheld)";
      continue;
    }
    out[key] = scrubbed(inner);
  }
  return out;
}

function shown(text) {
  try {
    return JSON.stringify(scrubbed(JSON.parse(text)));
  } catch {
    return JSON.stringify(text);
  }
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
  let response;
  if (step.rest !== undefined) {
    const [method, path] = step.rest.split(" ");
    const form = step.form
      ? new URLSearchParams(
          Object.entries(step.form).map(([key, value]) => [key, value === "@PASSWORD@" ? userPassword : value]),
        ).toString()
      : undefined;
    const printedForm = step.form
      ? ` ${JSON.stringify(Object.fromEntries(Object.entries(step.form).map(([k, v]) => [k, v === "@PASSWORD@" ? "(generated)" : v])))}`
      : "";
    console.log(`> as ${step.as}: ${step.rest}${printedForm}`);
    response = await fetch(`http://${host}:8091${path}`, {
      method,
      headers: {
        authorization: auth(step.as),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form,
    });
  } else {
    console.log(`> as ${step.as}: ${JSON.stringify(step.query)}`);
    response = await fetch(`http://${host}:8093/query/service`, {
      method: "POST",
      headers: { authorization: auth(step.as), "content-type": "application/json" },
      body: JSON.stringify(step.query),
    });
  }
  console.log(`  ${response.status} ${cut(shown(await response.text()))}`);
}
