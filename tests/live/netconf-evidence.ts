/**
 * Records what the NETCONF fixture actually answers, so the integration test can replay it.
 *
 * WHY A RECORDING AND NOT A FAKE. `tests/unit/db/netconf/` drives every module against
 * hand-written replies, which proves the rules and says nothing about what a device sends. This
 * writes down what Netopeer2 2.8.7 sent, byte for byte as the session received it, and
 * `tests/integration/db/netconf-provider.test.ts` replays those bytes through the real dial, the
 * real session, the real reader and the real provider. Only the socket is missing.
 *
 * WHAT IS RECORDED, AND WHAT THAT DOES AND DOES NOT REACH. The transport, which is the lowest
 * seam above the socket: every chunk the server sent, in arrival order. On replay the session's
 * FRAMING runs for real, and it is reached - 12 of the 13 recorded exchanges arrive in more than
 * one chunk, up to nine.
 *
 * It does NOT reach the UTF-8 boundary. `transportOf` decodes with a `StringDecoder` before
 * anything above it sees a chunk, so what is written down here is already whole characters, and
 * re-feeding those on replay splits only where a character already ended. Recording raw Buffers
 * would mean reimplementing `nodeSshPort` here, and it would buy nothing: the house already holds
 * that case where it belongs, in `tests/unit/db/netconf/netconf.test.ts` ("a four byte character
 * arriving in two reads decodes correctly"), whose own comment notes the split it feeds is one
 * the transport cannot produce. So this file claims the framing and not the decoder.
 *
 * MATCHED BY REQUEST, NOT BY ORDER. Each exchange is keyed by the RPC the session wrote, with its
 * `message-id` taken out, because the id counts up per session and a replay numbers its own. So
 * the integration test may ask in any order and may ask the same thing twice, and a request no
 * capture holds fails that test by name rather than being answered with something near it.
 *
 * Run it against the compose fixture (`docker/netconf/README.md`), from the repository root:
 *
 *   bun tests/live/netconf-evidence.ts
 *   bun tests/live/netconf-evidence.ts --target 127.0.0.1:1830 --out tests/fixtures/netconf
 *
 * It only reads, and it carries no credential: `NETCONF_LIVE_PASSWORD` has to be in the
 * environment, with `NETCONF_LIVE_USER` for the account if it is not the fixture's read-only one.
 * No password is written in this file and none has a default here - a password committed to a
 * repository is a published credential whatever it unlocks, and the fixture's own is printed by
 * `docker/netconf/README.md` where a reader can copy it into their shell:
 *
 *   NETCONF_LIVE_PASSWORD=... bun tests/live/netconf-evidence.ts --fingerprint SHA256:...
 *
 * THE FIXTURE'S INTERFACE COUNT IS PART OF THE RECORDING and this file does not set it, so it has
 * to be named when the container is started or the capture will not match the committed one:
 *
 *   docker run -d --name libredb-ci-netconf -e LIBREDB_NETCONF_INTERFACES=60 -p 127.0.0.1:1830:830 ...
 *
 * MEASURED while re-recording on 15 Oct 2026: the committed capture holds 300 `<interface>`
 * elements, which is SIXTY interfaces read back over five exchanges, not three hundred. Started at
 * the image's own default of 5,000 the capture came out 5.4 MB against 224 KB, and at 300 it came
 * out 469 KB; neither is wrong as a capture and both replay, but neither is the one the
 * integration test is pinned to.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nodeSocketPort, nodeSshPort } from "@/lib/db/providers/network/netconf/node-ports";
import type { SshPort, SshSession } from "@/lib/db/providers/network/netconf/dial";
import type { Transport } from "@/lib/db/providers/network/netconf/session";
import { openNetconfReader } from "@/lib/db/providers/network/netconf/open";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import type { DatabaseConnection } from "@/lib/types";

const DEFAULT_TARGET = "127.0.0.1:1830";
const DEFAULT_OUT = "tests/fixtures/netconf";

interface Exchange {
  /** The RPC as written, with the message-id removed. */
  readonly request: string;
  /** Every chunk the device sent in answer, in arrival order. */
  readonly chunks: string[];
}

/** What a replay needs that no request asked for: the hello the device opens with. */
interface Capture {
  readonly target: string;
  readonly takenAt: string;
  /**
   * THE DEVICE'S HOST KEY IS DELIBERATELY NOT RECORDED.
   *
   * It is public material, and a scanner cannot tell a public key from a private one: committed,
   * a 372-byte base64 blob with 5.8 bits of entropy per character is what a secret looks like,
   * and the repository's own pre-commit scan refuses it. So the replay builds a key of its own
   * and pins it, which runs every line of `hostkey.ts` just the same; whether a REAL device's key
   * matches a REAL pin is the live check's question, where both are present and neither is
   * committed.
   */
  readonly hello: string[];
  readonly exchanges: Exchange[];
}

/** The id counts up per session, so a replay could never match on it. */
export const withoutMessageId = (rpc: string): string => rpc.replace(/message-id="[^"]*"/g, 'message-id=""');

function parseArguments(argv: readonly string[]): { target: string; out: string; fingerprint: string } {
  let target = DEFAULT_TARGET;
  let out = DEFAULT_OUT;
  let fingerprint = process.env.NETCONF_LIVE_FINGERPRINT ?? "";
  for (let at = 0; at < argv.length; at += 1) {
    const value = argv[at + 1];
    if (argv[at] === "--target" && value !== undefined) {
      target = value;
      at += 1;
    } else if (argv[at] === "--out" && value !== undefined) {
      out = value;
      at += 1;
    } else if (argv[at] === "--fingerprint" && value !== undefined) {
      fingerprint = value;
      at += 1;
    } else {
      console.error(`netconf-evidence: unknown argument ${JSON.stringify(argv[at])}; nothing was dialled.`);
      process.exit(2);
    }
  }
  if (!fingerprint.startsWith("SHA256:")) {
    // Asked for rather than hardcoded, and that is the fixture's own shape: the Dockerfile
    // generates the host key at BUILD time, so every build has its own fingerprint and a constant
    // written here would be wrong on the next one. It is read out of band, which is also how the
    // provider's own refusal tells a reader to get it.
    console.error(
      "netconf-evidence: pass --fingerprint SHA256:... (or set NETCONF_LIVE_FINGERPRINT); read it with\n" +
        `  ssh-keyscan -p <port> <host> | ssh-keygen -lf -\nnothing was dialled.`,
    );
    process.exit(2);
  }
  return { target, out, fingerprint };
}

/**
 * The real SSH port, with the transport teed into a capture.
 *
 * The wrapper sits around the transport rather than replacing it, so the dial, the host key check
 * and the handshake all run exactly as they do in the app: what is added is a copy of the bytes.
 */
function recordingSshPort(capture: Capture): SshPort {
  return {
    connect: (options): SshSession => {
      const session = nodeSshPort.connect(options);
      return {
        onReady: session.onReady.bind(session),
        onError: session.onError.bind(session),
        end: session.end.bind(session),
        subsystem: (name, handler) =>
          session.subsystem(name, (error, transport) => {
            if (error !== null || transport === null) {
              handler(error, transport);
              return;
            }
            handler(null, recordingTransport(transport, capture));
          }),
      };
    },
  };
}

function recordingTransport(inner: Transport, capture: Capture): Transport {
  // Before the first write every chunk belongs to the hello; after it, to the exchange in flight.
  let current: Exchange | null = null;
  return {
    write: (text: string) => {
      current = { request: withoutMessageId(text), chunks: [] };
      capture.exchanges.push(current);
      inner.write(text);
    },
    onData: (handler) => {
      inner.onData((chunk: string) => {
        (current === null ? capture.hello : current.chunks).push(chunk);
        handler(chunk);
      });
    },
    onClose: (handler) => inner.onClose(handler),
    close: () => inner.close(),
  };
}

const { target, out, fingerprint } = parseArguments(process.argv.slice(2));
const host = target.slice(0, target.lastIndexOf(":"));
const port = Number(target.slice(target.lastIndexOf(":") + 1));

const livePassword = process.env.NETCONF_LIVE_PASSWORD;
if (livePassword === undefined || livePassword === "") {
  console.error(
    "netconf-evidence: set NETCONF_LIVE_PASSWORD (the fixture's read-only account, named in " +
      "docker/netconf/README.md); nothing was dialled.",
  );
  process.exit(2);
}

const capture: Capture = { target, takenAt: new Date().toISOString(), hello: [], exchanges: [] };

const connection = {
  id: "evidence",
  name: "fixture",
  type: "netconf",
  host,
  port,
  user: process.env.NETCONF_LIVE_USER ?? "ro-pass",
  password: livePassword,
  hostKeyFingerprint: fingerprint,
} as unknown as DatabaseConnection;

const reader = await openNetconfReader(connection, {
  xml: netconfXmlPort,
  socket: nodeSocketPort,
  ssh: recordingSshPort(capture),
});

/**
 * The calls the integration test makes, driven here so the device answers each one.
 *
 * `rows` on the whole interface list is the one that matters most: 5000 interfaces with a
 * four-byte character in every description is what puts a character across a chunk boundary.
 */
const MODULE = "ietf-interfaces";
const MONITORING = "ietf-netconf-monitoring";

console.log(`datastores: ${reader.facts.datastores.join(", ")}`);
console.log(`modules: ${reader.facts.modules.length}, nmda: ${reader.facts.nmda}`);

await reader.topLevelNodes("running", MODULE);
await reader.children("running", [{ name: "interfaces", module: MODULE }]);
await reader.rows("running", [{ name: "interfaces", module: MODULE }], 5);
await reader.rows("running", [{ name: "interfaces", module: MODULE }], 50);
await reader.sourceXml("running", [{ name: "interfaces", module: MODULE }]);
await reader.moduleText(MODULE);
await reader.topLevelNodes("operational", MONITORING);
await reader.children("operational", [{ name: "netconf-state", module: MONITORING }]);
await reader.rows("operational", [{ name: "netconf-state", module: MONITORING }], 5);
await reader.close();

mkdirSync(path.resolve(out), { recursive: true });
const file = path.join(path.resolve(out), "session.json");
writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`);

const bytes = capture.exchanges.reduce((sum, one) => sum + one.chunks.join("").length, 0);
console.log(
  `recorded ${capture.exchanges.length} exchanges, ${capture.hello.join("").length} bytes of hello and ` +
    `${bytes} bytes of answers, into ${path.relative(process.cwd(), file)}`,
);
