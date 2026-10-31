// TEMPORARY Windows diagnostic for the pacing hang; removed before merge.
import { writeSync } from "node:fs";
import { deviceKey, ModbusDevicePacer, ModbusPacingTimeout } from "@/lib/db/providers/industrial/modbus/agent-pacing";

const t0 = performance.now();
const say = (what: string) => writeSync(2, `[diag ${(performance.now() - t0).toFixed(1)}ms] ${what}\n`);
process.on("exit", (code) => say(`exit ${code}`));

say("plain race: timer vs pending promise");
const raced = await Promise.race([new Promise(() => undefined), new Promise((r) => setTimeout(() => r("expired"), 20))]);
say(`plain race answered ${String(raced)}`);

say("plain race with an async throw inside");
const thrown = await (async () => {
  await new Promise((r) => setTimeout(r, 20));
  throw new ModbusPacingTimeout(20);
})().catch((e: unknown) => e);
say(`thrown is pacing timeout: ${thrown instanceof ModbusPacingTimeout}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pacer = new ModbusDevicePacer(60);
const key = deviceKey("plc", 502);
say("pacer: first holds 80 ms");
const first = pacer.run(key, performance.now() + 5000, () => sleep(80).then(() => "first"));
say("pacer: late with a 20 ms deadline");
const late = pacer.run(key, performance.now() + 20, async () => "late");
const refused = await late.then(
  () => "ran",
  (e: unknown) => e,
);
say(`pacer: late settled, refused=${refused instanceof ModbusPacingTimeout}`);
say(`pacer: first settled ${await first}`);
say("done");
