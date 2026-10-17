// Prints the payload hex for tests/fixtures/sparkplug/tahu-datatypes.json. Run it from a scratch
// directory, so Eclipse Tahu never becomes a dependency of this repository:
//
//   mkdir -p /tmp/tahu && cd /tmp/tahu && npm install sparkplug-payload@1.0.3
//   node <repo>/tests/fixtures/sparkplug/record-tahu-datatypes.mjs
//
// IT PRINTS ONE FIELD, NOT THE FILE, and the header used to say otherwise: it told the reader to
// redirect this output over tahu-datatypes.json, which carries six more fields and whose key is
// `payloadHex` rather than `hex`. Following that line would have destroyed the fixture. The test
// reads `payloadHex`, so the loss would have been loud rather than silent, but a recipe that
// deletes what it claims to re-record is a recipe nobody can run twice. Paste the printed hex
// into the file's `payloadHex`; the JSON's own `regenerateWith` says the same thing.
import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/`);
const payload = require("sparkplug-payload").get("spBv1.0");
const TS = 1700000000000;
const metrics = [
  { name: "Int8Min", alias: 1, timestamp: TS, type: "Int8", value: -1 },
  { name: "Int16Min", alias: 2, timestamp: TS, type: "Int16", value: -32768 },
  { name: "Int32Neg", alias: 3, timestamp: TS, type: "Int32", value: -1 },
  { name: "UInt8Max", alias: 4, timestamp: TS, type: "UInt8", value: 255 },
  { name: "UInt32Max", alias: 5, timestamp: TS, type: "UInt32", value: 4294967295 },
  { name: "Int64Neg", alias: 6, timestamp: TS, type: "Int64", value: -5 },
  { name: "UInt64Max", alias: 7, timestamp: TS, type: "UInt64", value: "18446744073709551615" },
  { name: "DoubleOne", alias: 8, timestamp: TS, type: "Double", value: 42.5 },
  { name: "FloatOne", alias: 9, timestamp: TS, type: "Float", value: 1.5 },
  { name: "BoolTrue", alias: 10, timestamp: TS, type: "Boolean", value: true },
  { name: "TextOne", alias: 11, timestamp: TS, type: "String", value: "NIGHT-SHIFT" },
];
console.log(
  JSON.stringify({ hex: Buffer.from(payload.encodePayload({ timestamp: TS, seq: 0, metrics })).toString("hex") }),
);
