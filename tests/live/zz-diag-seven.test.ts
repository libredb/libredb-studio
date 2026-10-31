// TEMPORARY Windows diagnostic for the pacing hang; removed before merge.
import { expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { deviceKey, ModbusDevicePacer, ModbusPacingTimeout } from "@/lib/db/providers/industrial/modbus/agent-pacing";

const t0 = performance.now();
const say = (what: string) => writeSync(2, `[diag ${(performance.now() - t0).toFixed(1)}ms] ${what}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const far = () => performance.now() + 5000;

test(process.env.DIAG_SKIP_SIX ? "six (skipped)" : "six: a failed read frees the lane", async () => {
  if (process.env.DIAG_SKIP_SIX) return;
  say("six start");
  const pacer = new ModbusDevicePacer(60);
  const key = deviceKey("plc", 502);
  const failing = pacer.run(key, far(), async () => {
    await sleep(10);
    throw new Error("device gone");
  });
  const next = pacer.run(key, far(), async () => "ok");
  await expect(failing).rejects.toThrow("device gone");
  say("six failing rejected");
  await expect(next).resolves.toBe("ok");
  say("six end");
});

test("seven: a late read is refused", async () => {
  say("seven start");
  const pacer = new ModbusDevicePacer(60);
  const key = deviceKey("plc", 502);
  const first = pacer.run(key, far(), () => sleep(80).then(() => "first"));
  say("seven first queued");
  let ran = false;
  const late = pacer.run(key, performance.now() + 20, async () => {
    ran = true;
    return "late";
  });
  say("seven late queued");
  const refused = await late.then(
    () => undefined,
    (error: unknown) => error,
  );
  say(`seven late settled ${refused instanceof ModbusPacingTimeout}`);
  expect(refused).toBeInstanceOf(ModbusPacingTimeout);
  say("seven instanceof checked");
  expect((refused as ModbusPacingTimeout).waitedMs).toBeGreaterThanOrEqual(15);
  say(`seven waited ${(refused as ModbusPacingTimeout).waitedMs}`);
  expect(ran).toBe(false);
  await expect(first).resolves.toBe("first");
  say("seven end");
});
