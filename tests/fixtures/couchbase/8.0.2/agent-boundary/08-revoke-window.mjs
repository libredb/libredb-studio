// Measures how long the query service takes to honour a role granted and to stop honouring one taken away, while
// GET /whoami lists the change at once. The timings vary run to run; the shape is what the capture records. Usage: CB_ADMIN_PASSWORD=... CB_USER_PASSWORD=... node 08-revoke-window.mjs <host>
// Needs 00's buckets and function g_inline; makes and removes the user agent_revoke. Prints no password.
// oxlint-disable no-await-in-loop -- each read runs after the one before, on purpose: it times the window.
const [host] = process.argv.slice(2);
const admin = `Basic ${Buffer.from(`Administrator:${process.env.CB_ADMIN_PASSWORD ?? ""}`).toString("base64")}`;
const user = `Basic ${Buffer.from(`agent_revoke:${process.env.CB_USER_PASSWORD ?? ""}`).toString("base64")}`;
const setRoles = (roles) =>
  fetch(`http://${host}:8091/settings/rbac/users/local/agent_revoke`, {
    method: "PUT",
    headers: { authorization: admin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: process.env.CB_USER_PASSWORD ?? "", roles }).toString(),
  });
const whoamiRoles = async () =>
  ((await (await fetch(`http://${host}:8091/whoami`, { headers: { authorization: user } })).json()).roles ?? [])
    .map((entry) => entry.role)
    .join(",");
const call = async () => {
  const response = await fetch(`http://${host}:8093/query/service`, {
    method: "POST",
    headers: { authorization: user, "content-type": "application/json" },
    body: JSON.stringify({ statement: "SELECT default:g_inline(1) AS v", query_context: "default:`probe`" }),
  });
  const payload = await response.json();
  return payload.errors ? `refused ${payload.errors[0].code}` : `ran ${JSON.stringify(payload.results)}`;
};
/** Calls until the answer starts with `until`, every 50 ms for at most 120 s: how many calls answered otherwise, and the time. */
const pollUntil = async (until, since) => {
  let answer = await call();
  let other = 0;
  while (!answer.startsWith(until) && Date.now() - since < 120000) {
    other++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    answer = await call();
  }
  return `${other} call(s) answered otherwise, then ${answer}, ${Date.now() - since} ms after the change`;
};
for (let round = 1; round <= 10; round++) {
  // Each poll starts the moment the PUT has answered, before anything else is asked, and whoami is read after it.
  await setRoles("query_select[probe],query_execute_global_functions");
  const grantedAt = Date.now();
  const granted = await pollUntil("ran", grantedAt);
  console.log(`round ${round}: role granted: ${granted}; whoami then lists ${await whoamiRoles()}`);
  await setRoles("query_select[probe]");
  const revokedAt = Date.now();
  const revoked = await pollUntil("refused", revokedAt);
  console.log(`round ${round}: role taken away: ${revoked}; whoami then lists ${await whoamiRoles()}`);
}
await fetch(`http://${host}:8091/settings/rbac/users/local/agent_revoke`, {
  method: "DELETE",
  headers: { authorization: admin },
});
