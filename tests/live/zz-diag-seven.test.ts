// TEMPORARY Windows diagnostic for the pacing hang; removed before merge.
import { expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { deviceKey, ModbusDevicePacer, ModbusPacingTimeout } from "@/lib/db/providers/industrial/modbus/agent-pacing";

const t0 = performance.now();
const say = (what: string) => writeSync(2, `[diag ${(performance.now() - t0).toFixed(1)}ms] ${what}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const far = () => performance.now() + 5000;
const which = process.env.DIAG_VARIANT ?? "a";

test(`variant ${which}`, async () => {
  const pacer = new ModbusDevicePacer(60);
  const key = deviceKey("plc", 502);
  let finish!: (value: string) => void;
  const first =
    which === "a"
      ? pacer.run(key, far(), () => new Promise<string>((resolve) => (finish = resolve)))
      : pacer.run(key, far(), () => sleep(80).then(() => "first"));
  const late = pacer.run(key, performance.now() + 20, async () => "late");
  const refused = await late.then(
    () => undefined,
    (error: unknown) => error,
  );
  say(`${which}: refused ${refused instanceof ModbusPacingTimeout}`);
  if (which === "c") {
    say("c: a timer made after the refusal");
    await sleep(5);
    say("c: it fired");
    return;
  }
  if (which === "a") {
    await sleep(5);
    say("a: a new timer fired after the refusal");
    finish("first");
  }
  expect(await first).toBe("first");
  say(`${which}: first settled`);
  const next = await pacer.run(key, far(), async () => "after the gap");
  say(`${which}: ${next}`);
});
