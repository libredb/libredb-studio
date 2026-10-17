/**
 * Which failure reaches the user, and dressed as what (specification 11.2, landing condition).
 *
 * The table was written before anything called those paths and said so. Giving it a caller is what
 * produced the measurement this file pins: through the real route, an unreachable address and a
 * handshake that timed out both answered HTTP 500 `INTERNAL_ERROR`, logged "Unhandled error", for
 * facts the network decided. The classes below are what turn those into 503 `CONNECTION_ERROR`.
 *
 * Both directions, per row: the class it becomes AND that an unnamed error does NOT become one.
 */
import { test } from "bun:test";
import { expectBe, expectMatch, expectTruthy } from "./helpers";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { asHouseError } from "@/lib/db/providers/network/netconf/failures";
import { DialError } from "@/lib/db/providers/network/netconf/dial";
import { XmlReaderError } from "@/lib/db/providers/network/netconf/reader-port";
import { NetconfSessionError } from "@/lib/db/providers/network/netconf/session";

const TARGET = { host: "192.0.2.10", port: 830 } as const;

test("a socket or transport failure is the connection's, and the sentence names the address", () => {
  const given = asHouseError(
    new DialError({ kind: "transport", message: "Timed out while waiting for handshake" }),
    TARGET,
  );
  expectTruthy(given instanceof ConnectionError);
  // The address is the half the platform's own sentence leaves out, measured: `ECONNREFUSED`
  // carries it and a handshake deadline does not, so the reader was told a deadline passed without
  // being told which device missed it.
  expectMatch((given as Error).message, /192\.0\.2\.10:830/);
});

test("an address the sentence already names is not named twice", () => {
  const given = asHouseError(
    new DialError({ kind: "transport", message: "connect ECONNREFUSED 192.0.2.10:830" }),
    TARGET,
  );
  expectBe((given as Error).message, "connect ECONNREFUSED 192.0.2.10:830");
});

test("a pin that cannot be read is the settings' fault, because nothing was sent", () => {
  const given = asHouseError(
    new DialError({ kind: "configuration", reason: "pin-unreadable", message: "paste the SHA256: line" }),
    TARGET,
  );
  expectTruthy(given instanceof DatabaseConfigError);
});

test("a host key that does not match the pin is the connection's, not the credential's", () => {
  const given = asHouseError(
    new DialError({ kind: "host-key", message: "this device's key is not the pinned one" }),
    TARGET,
  );
  expectTruthy(given instanceof ConnectionError);
});

test("a refused credential is the credential's", () => {
  const given = asHouseError(new DialError({ kind: "refused", message: "authentication failed" }), TARGET);
  expectTruthy(given instanceof AuthenticationError);
});

test("a session that ended is the connection's, because it spoils every later read", () => {
  const given = asHouseError(new NetconfSessionError({ reason: "closed-by-peer" }), TARGET);
  expectTruthy(given instanceof ConnectionError);
});

test("a message the reader refused is this read's alone", () => {
  const given = asHouseError(new XmlReaderError({ kind: "doctype" }), TARGET);
  expectTruthy(given instanceof QueryError);
});

/**
 * THE ROW WITH NO CONVERSION, and it is the one that makes the others mean something.
 *
 * A `TypeError` is not a fact about the device. Dressing it as one sends a reader to the device for
 * a defect of ours, so it is returned as the SAME OBJECT - asserted by identity, which a
 * re-wrapping would break even if the message survived.
 */
test("an error of our own is raised unchanged, by identity", () => {
  const ours = new TypeError("undefined is not an object");
  expectBe(asHouseError(ours, TARGET), ours);
  expectBe(asHouseError(ours), ours);
});
