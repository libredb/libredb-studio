// Proves the NETCONF fixture is the fixture the provider's tests assume. It is not a provider
// test: it reads the server over ssh2, the library the provider itself dials with, and asserts
// what a silently broken fixture would get wrong.
//
// Three things are checked, and each one has been seen to fail in a way that compiles, builds and
// tags cleanly (measured 2026-10-13):
//   1. the container answers on the port at all (a missing /usr/local/sbin copy builds an image
//      whose server binary is absent),
//   2. a session opens and the server says hello (a half-applied ietf-netconf-server config
//      leaves accounts that cannot log in),
//   3. the read-only account is actually read-only (without the NACM rule-list the same account
//      keeps lock, unlock, discard-changes, validate and copy-config).
//
// Usage: node docker/netconf/verify.mjs <port> <private-key-file>
import { Client } from "ssh2";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] || 1830);
const KEY = process.argv[3];
const HOST = "127.0.0.1";
const USER = "ro-key";
const EOM = "]]>]]>";

const REFUSED = [
  ["lock", "<lock><target><running/></target></lock>"],
  ["unlock", "<unlock><target><running/></target></unlock>"],
  ["edit-config", "<edit-config><target><running/></target><config/></edit-config>"],
  ["copy-config", "<copy-config><target><startup/></target><source><running/></source></copy-config>"],
  ["delete-config", "<delete-config><target><startup/></target></delete-config>"],
  ["commit", "<commit/>"],
  ["validate", "<validate><source><running/></source></validate>"],
  ["discard-changes", "<discard-changes/>"],
  ["kill-session", "<kill-session><session-id>1</session-id></kill-session>"],
  ["create-subscription", '<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"/>'],
];
const PERMITTED = [
  ["get-config", "<get-config><source><running/></source></get-config>"],
  ["get-schema", '<get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><identifier>ietf-interfaces</identifier><format>yang</format></get-schema>'],
];

function session(requests) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const replies = new Map();
    let notifications = 0;
    let fingerprint = null;
    const timer = setTimeout(() => reject(new Error("the fixture did not answer within 30s")), 30000);
    client.on("ready", () => {
      client.subsys("netconf", (error, stream) => {
        if (error) return reject(error);
        let buffer = "";
        let sent = 0;
        const next = () => {
          if (sent >= requests.length) return stream.end();
          stream.write(`<rpc message-id="${sent + 1}" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">${requests[sent]}</rpc>${EOM}`);
        };
        stream.write(`<?xml version="1.0" encoding="UTF-8"?><hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities></hello>${EOM}`);
        stream.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let at;
          while ((at = buffer.indexOf(EOM)) !== -1) {
            const message = buffer.slice(0, at);
            buffer = buffer.slice(at + EOM.length);
            // Replies are matched by message-id, not by arrival order. A server that accepts
            // create-subscription starts sending notifications, and an order based reader counts
            // those as replies and then blames the wrong operation. Measured 2026-10-13 while
            // breaking this check on purpose: it reported 17 replies to 12 requests and named the
            // wrong request as the failing one.
            const id = /message-id="(\d+)"/.exec(message);
            if (id) {
              replies.set(Number(id[1]), message);
              sent += 1;
              next();
            } else if (message.includes("<hello")) {
              replies.set(0, message);
              next();
            } else {
              notifications += 1;
            }
          }
        });
        stream.on("close", () => { clearTimeout(timer); client.end(); resolve({ fingerprint, replies, notifications }); });
      });
    });
    client.on("error", (error) => { clearTimeout(timer); reject(error); });
    // A fixture whose accounts are half configured refuses the login, and the reason has to be a
    // sentence rather than an unhandled rejection: measured 2026-10-13, removing the configured
    // users made this script print an ssh2 stack trace instead of saying what was wrong.
    client.connect({
      host: HOST, port: PORT, username: USER, privateKey: readFileSync(KEY), readyTimeout: 20000,
      hostVerifier: (key) => { fingerprint = key.length > 0; return true; },
    });
  });
}

const requests = [...REFUSED, ...PERMITTED].map(([, body]) => body);
let result;
try {
  result = await session(requests);
} catch (error) {
  console.error("NETCONF fixture check FAILED");
  console.error(`  no session could be opened on 127.0.0.1:${PORT} as ${USER}: ${error.message}`);
  console.error("  a login refusal here usually means the fixture's accounts were not fully applied");
  process.exit(1);
}
const { replies, notifications } = result;
const hello = replies.get(0) ?? "";

const failures = [];
if (!hello.includes("<session-id>")) failures.push("the hello carried no session-id");
if (notifications > 0) {
  failures.push(`the server sent ${notifications} notifications, so a subscription was accepted`);
}

[...REFUSED, ...PERMITTED].forEach(([name], index) => {
  const reply = replies.get(index + 1);
  if (reply === undefined) failures.push(`${name} got no reply carrying its message-id`);
});
REFUSED.forEach(([name], index) => {
  const reply = replies.get(index + 1) ?? "";
  if (!reply.includes("<error-tag>access-denied</error-tag>")) {
    failures.push(`${name} was not refused with access-denied: ${reply.slice(0, 120)}`);
  }
});
PERMITTED.forEach(([name], index) => {
  const reply = replies.get(REFUSED.length + index + 1) ?? "";
  if (reply.includes("<rpc-error>") || !reply.includes("<data")) {
    failures.push(`${name} did not return data: ${reply.slice(0, 120)}`);
  }
});

if (failures.length > 0) {
  console.error("NETCONF fixture check FAILED");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`NETCONF fixture check passed: hello ${hello.length} bytes, ${REFUSED.length} operations refused with access-denied, ${PERMITTED.length} reads answered`);
