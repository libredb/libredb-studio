/**
 * Opt-in live check of row A63 for the s3 provider: through a real SSH tunnel to `silo`
 * (plain HTTP, no consent asked, because a tunnel is exempt), then to `silo-tls` with verify-full, the certificate
 * checked against the far end's name `silo-tls`, never the tunnel's local 127.0.0.1; then a far end 169.254.169.254,
 * refused with the link-local sentence after the SSH dial to the bastion and before any socket to the tunnel's local
 * forward. The factory opens the SSH session before the provider's connect() checks the far end. The bastion forwards
 * only when a socket reaches the local forward, so it is never asked to reach 169.254.169.254.
 *
 * Apart from tests/live/s3-live-check.ts because it builds the provider through `getOrCreateProvider`, the only path
 * that opens a tunnel and sets TUNNEL_FAR_END, and the factory statically imports every engine's provider, which the
 * Node bundle of that check must not carry. So this runs under Bun only.
 *
 * The signed and sent Host is the local forward: the server verifies the Host it receives, so the signature holds; a
 * server behind the tunnel that routes by Host name is not supported in v1, and this row is where that is measured.
 *
 * Every step counts the sockets it opens with the same node:net connect spy tests/live/s3-live-check.ts uses, except
 * the dial to the bastion. So the link-local step asserts zero exchanges and zero sockets besides the bastion's. A
 * refusal that came after a socket to the local forward fails it.
 *
 * The bastion is the kind tests/live/etcd-tunnel-check.ts uses: SSH on 127.0.0.1:12222, user `tunnel`, attached to
 * the compose network so it reaches `silo` and `silo-tls` by service name; docker/s3/README.md records the exact
 * `docker run` that started it. Run it with the bastion, silo and silo-tls up:
 *
 *   LIVE_SSH_PASSWORD=... bun tests/live/s3-tunnel-check.ts --ca <copy of the s3-certs volume>/ca.pem
 *
 * The password has no default, and neither does any credential here. Every line it prints has the password and each
 * Silo fixture secret, in every spelling of the scrub, replaced by <secret> (maskSecrets).
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { getOrCreateProvider, removeProvider } from "@/lib/db/factory";
import { maskSecrets } from "../helpers/s3-evidence-scrub";
import {
  checkS3Step,
  fixtureSecrets,
  readS3Principals,
  runS3Row,
  S3_ACCEPTANCE,
  type S3RunContext,
} from "./s3-live-support";

function usage(message: string): never {
  console.error(`s3-tunnel-check.ts: ${message}`);
  process.exit(2);
}

const password = process.env.LIVE_SSH_PASSWORD;
if (password === undefined || password === "")
  usage("Set LIVE_SSH_PASSWORD: this check talks to a real bastion and a real Silo.");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--ca") usage("pass --ca <copy of the s3-certs volume>/ca.pem");
const ca = readFileSync(args[1], "utf8");
const principals = readS3Principals("silo");
const secrets = [...fixtureSecrets("silo", principals), { label: "SSH password", value: password }];
const mask = (text: string) => maskSecrets(text, secrets);

// The SSH bastion, named once for the tunnel config and for the spy that leaves its dial out.
const BASTION = { host: "127.0.0.1", port: 12222 };

// Every socket a step opens, counted where node:net opens it, except the dial to the bastion. ssh2 dials with an
// options object, so only that exact shape is left out; any other argument shape is counted.
let sockets = 0;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...rest: unknown[]) {
  const target = rest[0] as { host?: unknown; port?: unknown } | null;
  const bastion =
    typeof target === "object" && target !== null && target.host === BASTION.host && target.port === BASTION.port;
  if (!bastion) sockets++;
  return (connect as (...a: unknown[]) => net.Socket).apply(this, rest);
} as typeof net.Socket.prototype.connect;

const opened: string[] = [];
const run: S3RunContext = {
  target: "silo",
  principals,
  ca,
  createTransport: () => {
    throw new Error("the tunnel check builds every provider through the factory");
  },
  clockFor: () => () => new Date(),
  signerWrapper: (signer) => signer,
  setStep: () => {},
  sockets: () => sockets,
  recorded: () => [],
  tunnel: {
    sshTunnel: {
      enabled: true,
      host: BASTION.host,
      port: BASTION.port,
      username: "tunnel",
      authMethod: "password",
      password,
    },
    open: async (connection) => {
      opened.push(connection.id);
      return getOrCreateProvider(connection);
    },
  },
};

const row = S3_ACCEPTANCE.find((candidate) => candidate.id === "A63");
if (row === undefined) throw new Error("S3_ACCEPTANCE holds no A63");
let passed = 0;
let failed = false;
const steps = row.expect.silo.map(({ step }) => step);
try {
  const runs = await runS3Row("A63", run, steps);
  for (const stepRun of runs) {
    const outcome = row.expect.silo.find(({ step }) => step === stepRun.summary.step)?.outcome;
    const failure =
      outcome === undefined
        ? `no cell step ${stepRun.summary.step}`
        : checkS3Step(outcome, stepRun.summary, stepRun.context, stepRun.sockets);
    if (failure === undefined) passed++;
    else failed = true;
    console.log(
      mask(failure === undefined ? `PASS A63 ${stepRun.summary.step}` : `FAIL A63 ${stepRun.summary.step}: ${failure}`),
    );
  }
} catch (error) {
  failed = true;
  console.log(mask(`FAIL A63: ${error instanceof Error ? error.message : String(error)}`));
} finally {
  for (const id of opened) await removeProvider(id);
}
console.log(mask(`${passed} of ${steps.length} checks passed on silo through the tunnel (bun ${Bun.version})`));
process.exit(failed ? 1 : 0);
