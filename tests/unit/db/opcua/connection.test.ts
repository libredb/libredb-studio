/**
 * What a connection is, and every refusal it makes before anything is dialled (#1677 section 4).
 */
import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import { getDataDir } from "@/lib/data-dir";
import { DatabaseConfigError } from "@/lib/db/errors";
import { TUNNEL_FAR_END } from "@/lib/types";
import { readConnection } from "@/lib/db/providers/industrial/opcua/connection";
import { OPCUA_PKI_DIRECTORY, OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import type { DatabaseConnection } from "@/lib/types";

const ENV = { [OPCUA_PKI_ROOT_ENV]: "/app/data/opcua-pki" } as const;

function connection(over: Record<string, unknown>): DatabaseConnection & Record<string, unknown> {
  return {
    id: "o",
    name: "o",
    type: "opcua",
    host: "opc.tcp://plc.ornek.net:4840/",
    ...over,
  } as never;
}

describe("the endpoint", () => {
  test("host and port are read from the URL, which is the only address there is", () => {
    const options = readConnection(connection({}), ENV);
    expect(options.host).toBe("plc.ornek.net");
    expect(options.port).toBe(4840);
    expect(options.endpointUrl).toBe("opc.tcp://plc.ornek.net:4840/");
  });

  test("a URL in another scheme is refused", () => {
    expect(() => readConnection(connection({ host: "http://plc/" }), ENV)).toThrow(DatabaseConfigError);
  });

  test("an empty endpoint is refused", () => {
    expect(() => readConnection(connection({ host: "" }), ENV)).toThrow(/needs an endpoint URL/);
  });
});

describe("the security mode", () => {
  /** The strongest mode is the default, because a weaker default would silently downgrade. */
  test("nothing said means SignAndEncrypt", () => {
    expect(readConnection(connection({}), ENV).mode).toBe("SignAndEncrypt");
  });

  test("each of the three modes is taken as given", () => {
    for (const mode of ["None", "Sign", "SignAndEncrypt"] as const) {
      expect(readConnection(connection({ securityMode: mode }), ENV).mode).toBe(mode);
    }
  });

  /** No default for an unknown mode: defaulting would weaken a connection meant to be secured. */
  test("a mode this does not know is refused rather than defaulted", () => {
    expect(() => readConnection(connection({ securityMode: "require" }), ENV)).toThrow(/None, Sign or SignAndEncrypt/);
    expect(() => readConnection(connection({ securityMode: "verify-full" }), ENV)).toThrow(
      /must not fall back to None/,
    );
  });
});

describe("the security policy", () => {
  test("a typed policy URI is carried trimmed, and a blank one is absent rather than empty", () => {
    const policy = "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256";
    expect(readConnection(connection({ securityPolicyUri: `  ${policy}  ` }), ENV).policyUri).toBe(policy);
    expect(readConnection(connection({ securityPolicyUri: "   " }), ENV).policyUri).toBeUndefined();
    expect(readConnection(connection({}), ENV).policyUri).toBeUndefined();
  });
});

describe("the identity", () => {
  test("no username is an anonymous session", () => {
    const options = readConnection(connection({}), ENV);
    expect(options.identity).toBe("anonymous");
    expect(options.user).toBeUndefined();
  });

  test("a username is a username session", () => {
    const options = readConnection(connection({ user: "okuyucu", password: "s3cret" }), ENV);
    expect(options.identity).toBe("username");
    expect(options.user).toBe("okuyucu");
  });

  test("a password with no username names no identity, and is refused", () => {
    expect(() => readConnection(connection({ password: "s3cret" }), ENV)).toThrow(/names no identity/);
  });
});

describe("the pinned server certificate", () => {
  const PLC = "b9432ed131e30092d2a0619284763a403c33fc3929546728864b27b475c9529a";

  test("an operator's paste is normalised however their tool printed it", () => {
    expect(
      readConnection(
        connection({
          // The same thumbprint as `PLC`, in the upper-case colon-separated form a certificate
          // dialog prints: what the operator actually has on their clipboard.
          serverCertificateThumbprint: PLC.toUpperCase().replace(/(..)(?=.)/g, "$1:"),
        }),
        ENV,
      ).pinnedThumbprint,
    ).toBe(PLC);
  });

  test("no pin is no pin, rather than an empty one", () => {
    expect(readConnection(connection({ serverCertificateThumbprint: "  " }), ENV).pinnedThumbprint).toBeUndefined();
  });

  test("something that is not a thumbprint is refused, with the form it should take", () => {
    expect(() => readConnection(connection({ serverCertificateThumbprint: "deadbeef" }), ENV)).toThrow(
      /64 hexadecimal/,
    );
  });
});

describe("the PKI root and the client's own identity", () => {
  /**
   * NO VARIABLE IS STUDIO'S OWN DATA DIRECTORY. The library's default still cannot be used - in the
   * image `os.homedir()` is `/nonexistent` - which is why the default is a directory Studio already
   * owns and writes to, rather than nothing at all: measured in a real browser, refusing here meant
   * a reader who picked OPC UA could not connect until they found an environment variable.
   */
  test("no PKI variable falls back to Studio's own data directory, absolute", () => {
    const read = readConnection(connection({}), {});
    expect(read.pkiRoot).toBe(resolve(getDataDir(), OPCUA_PKI_DIRECTORY));
    expect(isAbsolute(read.pkiRoot)).toBe(true);
  });

  test("a certificate without its key is refused", () => {
    expect(() => readConnection(connection({ clientCertificatePath: "/c.pem" }), ENV)).toThrow(
      /together or not at all/,
    );
  });

  test("both supplied is carried through", () => {
    const options = readConnection(
      connection({
        clientCertificatePath: "/run/secrets/c.pem",
        clientPrivateKeyPath: "/run/secrets/k.pem",
      }),
      ENV,
    );
    expect(options.clientCertificatePath).toBe("/run/secrets/c.pem");
    expect(options.clientPrivateKeyPath).toBe("/run/secrets/k.pem");
  });
});

/**
 * THE DIALOG'S OWN FIELD, and the SSL panel's is not read at all.
 *
 * Measured before this test existed: the dialog wrote `securityMode`, this reader read `sslMode`,
 * and a reader who chose **None** got a SignAndEncrypt dial and a refusal that blamed the server
 * for offering no SignAndEncrypt endpoint. The shared SSL panel is not offered for this engine
 * either (`showSslPanel: false`), so its vocabulary never reaches here.
 */
describe("the field the dialog writes", () => {
  test("the SSL panel's own mode is ignored, whatever it says", () => {
    const withSslMode = readConnection(
      connection({
        securityMode: "None",
        sslMode: "verify-full",
        ssl: { mode: "require" },
      }),
      ENV,
    );
    expect(withSslMode.mode).toBe("None");
    // And with no security mode at all, the provider's own default stands.
    expect(readConnection(connection({ sslMode: "require" }), ENV).mode).toBe("SignAndEncrypt");
  });
});

/**
 * A PIN ON A `None` CHANNEL IS REFUSED, because this provider measured that it cannot be enforced
 * there and then enforced it anyway. `security.ts` records the measurement: with a strict
 * certificate manager a None connect succeeds and `checkCertificate` is never called, so the trust
 * list is never consulted - and the thumbprint the pin is compared against came from an unsigned
 * GetEndpoints reply, which any host answering on that address can write.
 *
 * Measured before the refusal: `None` + the right pin opened a session and `None` + a wrong pin was
 * refused by name, which teaches an operator that the pin is protecting them - while the dialog's
 * own hint and the guide both say a certificate cannot be pinned on a None channel.
 */
describe("a pin and the mode it is pinned on", () => {
  const PIN = "b9432ed131e30092d2a0619284763a403c33fc3929546728864b27b475c9529a";

  test("a pin on None is refused, and the sentence names both ways out", () => {
    expect(() => readConnection(connection({ securityMode: "None", serverCertificateThumbprint: PIN }), ENV)).toThrow(
      /cannot be enforced on a None channel/,
    );
    expect(() => readConnection(connection({ securityMode: "None", serverCertificateThumbprint: PIN }), ENV)).toThrow(
      /Choose Sign or Sign and Encrypt[\s\S]*or clear the pin/,
    );
  });

  test.each(["Sign", "SignAndEncrypt"])("a pin on %s is carried, because there it means something", (mode) => {
    const read = readConnection(connection({ securityMode: mode, serverCertificateThumbprint: PIN }), ENV);
    expect(read.pinnedThumbprint).toBe(PIN);
  });

  /** And None with no pin is still allowed: the refusal is about the PAIR, not about the mode. */
  test("None with no pin is unchanged", () => {
    const read = readConnection(connection({ securityMode: "None" }), ENV);
    expect(read.mode).toBe("None");
    expect(read.pinnedThumbprint).toBeUndefined();
  });
});

describe("the tunnel", () => {
  test("an enabled tunnel is carried, because the plaintext rule reads it", () => {
    // The far end carries the pair the reader typed, so for this engine its `host` is the endpoint URL.
    const farEnd = {
      [TUNNEL_FAR_END]: { host: "opc.tcp://plc.example.net:4840", port: 4840 },
    };
    expect(readConnection(connection({ sshTunnel: { enabled: true }, ...farEnd }), ENV).tunnelled).toBe(true);
    expect(readConnection(connection({ sshTunnel: { enabled: false } }), ENV).tunnelled).toBe(false);
    expect(readConnection(connection({}), ENV).tunnelled).toBe(false);
  });
});

/**
 * A TUNNEL REWRITES THE ADDRESS BEFORE A PROVIDER SEES IT, and for this engine the address is a URL.
 *
 * `tunnelledConnection` replaces `host` with the local end and carries the real pair under
 * `TUNNEL_FAR_END`. Measured before this was handled: `host` became a bare `127.0.0.1`, which is no
 * URL, and every tunnelled connection was refused with "An endpoint URL reads opc.tcp://host:port/path".
 */
describe("the endpoint URL through a tunnel", () => {
  /**
   * THE FIXTURE IS BUILT THE WAY THE FACTORY BUILDS IT, and that is the whole point of this block:
   * the first attempt at this read the two addresses the wrong way round, and a test whose fixture
   * inverted them agreed with it. `tunnelledConnection` (`src/lib/db/factory.ts`) hands a provider
   * `host`/`port` of the forward's LOCAL end and `TUNNEL_FAR_END` holding the connection's own
   * `host`/`port` as the reader typed them - which for this engine means the far end's `host` IS
   * the endpoint URL, because the factory opens the forward with
   * `createSSHTunnel(id, sshTunnel, connection.host, connection.port)`.
   */
  function tunnelled(typedUrl: string, over: Record<string, unknown> = {}): DatabaseConnection {
    return {
      ...connection({
        host: "127.0.0.1",
        port: 57_321,
        sshTunnel: { enabled: true },
        ...over,
      }),
      [TUNNEL_FAR_END]: { host: typedUrl, port: 4840 },
    } as never;
  }

  test("the local end is dialled, and the scheme and path the reader typed are kept", () => {
    const read = readConnection(tunnelled("opc.tcp://plc.example.net:4840/milo") as never, ENV);
    expect(read.endpointUrl).toBe("opc.tcp://127.0.0.1:57321/milo");
    expect(read.host).toBe("127.0.0.1");
    expect(read.port).toBe(57_321);
    expect(read.tunnelled).toBe(true);
  });

  test("a URL with no path keeps none, so the dialled address is the bare authority", () => {
    const read = readConnection(tunnelled("opc.tcp://plc.example.net:4840") as never, ENV);
    expect(read.endpointUrl).toBe("opc.tcp://127.0.0.1:57321");
  });

  test("a tunnel the factory has not opened is refused, not dialled at the local port of nothing", () => {
    expect(() => readConnection(connection({ sshTunnel: { enabled: true } }), ENV)).toThrow(
      /tunnel that is not open yet/,
    );
  });

  test("the reader's own URL is still validated, so a wrong scheme says so", () => {
    expect(() => readConnection(tunnelled("https://plc.example.net:4840/") as never, ENV)).toThrow(/opc.tcp:\/\/ only/);
  });

  /** The control: with no tunnel, the typed URL is dialled unchanged. */
  test("without a tunnel nothing is rebuilt", () => {
    const read = readConnection(connection({ host: "opc.tcp://plc.example.net:4840/milo" }), ENV);
    expect(read.endpointUrl).toBe("opc.tcp://plc.example.net:4840/milo");
    expect(read.host).toBe("plc.example.net");
  });
});
