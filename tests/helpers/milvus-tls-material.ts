/**
 * Certificates made at test time with openssl, into a temporary directory, and never committed: the Milvus
 * connection's preflight tests and its real handshakes read them (vector-family spec E6, R42 M12). The shape of the
 * etcd handshake test's own generator; P-256 keys, one-day validity.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MilvusTlsMaterial {
  readonly dir: string;
  pem(file: string): string;
  remove(): void;
}

const CA = ["basicConstraints = critical, CA:TRUE", "keyUsage = critical, keyCertSign, cRLSign"];
const server = (names: string) => [
  "basicConstraints = CA:FALSE",
  `subjectAltName = ${names}`,
  "extendedKeyUsage = serverAuth",
];
const CLIENT = ["basicConstraints = CA:FALSE", "extendedKeyUsage = clientAuth"];
/** A stand-in passphrase for the encrypted-key case, never a realistic value. */
const KEY_PASSPHRASE = "password-second";

export function makeMilvusTlsMaterial(): MilvusTlsMaterial {
  if (Bun.which("openssl") === null) {
    throw new Error("No openssl on PATH: the Milvus TLS tests make their certificates at test time; install OpenSSL");
  }
  const dir = mkdtempSync(join(tmpdir(), "milvus-tls-"));
  const env = { ...process.env, OPENSSL_CONF: join(dir, "openssl.cnf") };
  writeFileSync(join(dir, "openssl.cnf"), "[req]\ndistinguished_name = dn\n[dn]\n");
  const openssl = (...args: string[]) => {
    const run = Bun.spawnSync(["openssl", ...args], { cwd: dir, env, stdout: "ignore", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${run.stderr.toString()}`);
  };
  let serial = 1000;
  const certificate = (name: string, subject: string, extensions: readonly string[], issuer = name) => {
    writeFileSync(join(dir, `${name}.ext`), `${extensions.join("\n")}\n`);
    openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key`);
    openssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${subject}`, "-out", `${name}.csr`);
    const signer =
      issuer === name
        ? ["-key", `${name}.key`]
        : ["-CA", `${issuer}.crt`, "-CAkey", `${issuer}.key`, "-set_serial", String(serial++)];
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      ...signer,
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.crt`,
    );
  };
  certificate("ca", "libredb-test-ca", CA);
  certificate("other-ca", "libredb-other-ca", CA);
  certificate("self-signed", "localhost", server("DNS:localhost"));
  certificate("localhost", "localhost", server("DNS:localhost, IP:127.0.0.1"), "ca");
  certificate("ip-only", "milvus-ip", server("IP:127.0.0.1"), "ca");
  certificate("far-ip", "milvus-far-ip", server("IP:10.0.0.5"), "ca");
  certificate("far-dns", "milvus.test", server("DNS:milvus.test"), "ca");
  certificate("client", "reader", CLIENT, "ca");
  certificate("client-other-ca", "reader", CLIENT, "other-ca");
  certificate("client-serverauth", "reader", ["basicConstraints = CA:FALSE", "extendedKeyUsage = serverAuth"], "ca");
  certificate("client-noeku", "reader", ["basicConstraints = CA:FALSE"], "ca");
  openssl("pkey", "-in", "client.key", "-aes256", "-passout", `pass:${KEY_PASSPHRASE}`, "-out", "client-encrypted.key");
  return {
    dir,
    pem: (file) => readFileSync(join(dir, file), "utf8"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
