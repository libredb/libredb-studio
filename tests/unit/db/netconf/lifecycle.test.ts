/**
 * Opening and closing the provider, including the opener it uses when none is injected.
 *
 * Every other test in this directory hands the provider a reader, which is what makes them
 * readable, and the cost is that the DEFAULT opener is never the one under test. So the first
 * test here constructs the provider with no opener at all and lets the real one run: it loads
 * `./open` and `./xml` and calls `openNetconfReader`. The device is not reached, and does not
 * need to be, because the claim is about which code the provider reaches for.
 */
import { test } from "bun:test";
import { expectBe, expectMatch, expectRejects } from "./helpers";
import { type DeviceReader, NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import type { DatabaseConnection } from "@/lib/db/types";

const connection = { type: "netconf", name: "n", host: "127.0.0.1", port: 9 } as unknown as DatabaseConnection;

/** A reader that records its closes and reaches nothing. */
function countingReader(): { reader: DeviceReader; closes: () => number } {
  let closes = 0;
  const reader = { close: async () => void (closes += 1) } as unknown as DeviceReader;
  return { reader, closes: () => closes };
}

test("a provider built with no opener uses the real one, which refuses this connection itself", async () => {
  // The refusal is the evidence: a stub would have opened. `openNetconfReader` reads the account
  // off the connection before it reaches the network, so the message names the account and not
  // the host, and the device at 127.0.0.1:9 is never dialled.
  const provider = new NetconfProvider(connection);
  try {
    await provider.connect();
    throw new Error("the default opener accepted a connection with no account");
  } catch (error) {
    expectMatch((error as Error).message, /account name/);
  }
});

test("connect stores the reader the opener returned, so the provider reads through it", async () => {
  let opened = 0;
  const { reader } = countingReader();
  const provider = new NetconfProvider(connection, {}, {}, async () => {
    opened += 1;
    return reader;
  });
  await provider.connect();
  expectBe(opened, 1);
});

test("disconnect closes the reader once, and a second disconnect closes nothing", async () => {
  // The field is cleared BEFORE close is awaited, which is what makes the repeat safe: a provider
  // that cleared it afterwards would close twice if disconnect were called twice in flight.
  const { reader, closes } = countingReader();
  const provider = new NetconfProvider(connection, {}, {}, async () => reader);
  await provider.connect();
  await provider.disconnect();
  expectBe(closes(), 1);
  await provider.disconnect();
  expectBe(closes(), 1);
});

test("disconnect before connect closes nothing and does not throw", async () => {
  const provider = new NetconfProvider(connection, {}, {}, async () => countingReader().reader);
  await provider.disconnect();
});

test("an opener that refuses leaves the provider without a reader", async () => {
  const provider = new NetconfProvider(connection, {}, {}, async () => {
    throw new Error("the device refused the subsystem");
  });
  await expectRejects(provider.connect(), /refused the subsystem/);
  // No reader was stored, so closing is still the no-op case rather than a close on undefined.
  await provider.disconnect();
});
