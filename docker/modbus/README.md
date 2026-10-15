# The Modbus TCP fixture

`modbus_server.json` configures the `modbus` service of `database-compose.yml`, which runs
`oitc/modbus-server` pinned by digest:

    oitc/modbus-server@sha256:32bfe144512e1f070cf7e7e2513cdcb774d74db142ee5dbad45b21d6d705ab97

The image wraps **pymodbus 3.12.x**, so the framing, the function-code decoding and the exception
responses are all third-party: the only thing this file decides is the values.

That is the point of it. Until this fixture existed the Modbus provider was measured against a
server written in this repository, which left one question open on every read: the side that wrote
the device and the side that read it were the same side.

The digest is written in three places and `tests/unit/db/modbus/live-environment.test.ts` holds
them to one: here, in `compose-service.yml` and in `ci-step.yml`. The last two are delivery files
rather than the shared ones, because `database-compose.yml` and `.github/workflows/ci.yml` are
landed by one hand.

## The values, and why they look like that

| table | wire address | value |
| --- | --- | --- |
| holding register | 0 to 9 | `7000 + 11 x N` |
| input register | 0 to 7 | `8500 - 7 x N`, descending |
| coil | 0 to 9 | on where `N mod 3 == 0` |
| discrete input | 0 to 7 | on where N is prime |

The multiplier and the descending run are deliberate. An off-by-one against `1000 + N` moves a
value by one and reads like a plausible number; against `7000 + 11 x N` it moves by eleven and is
unmissable. A descending table makes a reversed range visible for the same reason.

Addresses past the end of each table answer `0` rather than an exception, because
`initializeUndefinedRegisters` is true: holding from 10, input from 8, coil from 10, discrete
from 8.

## The trap this file exists to record

**The JSON keys are one-based, and the wire is zero-based.** Key `"1"` answers wire address 0. The
tables above are written shifted by one for that reason, and the shift is the image's shape rather
than a defect in it.

It cost half an hour the first time, and it was caught only because the multiplier pattern made it
obvious: the keys were first written from `0`, and the wire answered `7011, 7022, ...` where
`7000, 7011, ...` was meant - a visible slip. With a `1000 + N` pattern the same slip answers
`1001, 1002, ...` and looks exactly like a correct table.

## Checking it without the thing being measured

The values above were verified with raw Modbus TCP frames built by hand, not with this
repository's own client: a fixture's correctness has to be independent of the provider it is there
to measure. A holding-register read of addresses 0 to 4 answers `7000, 7011, 7022, 7033, 7044`.

## One thing this fixture does NOT reproduce

`docs/providers/modbus.md` section 3.4 records that a **libmodbus** server serving one client at a
time left a second client's read unanswered for 3003 ms, which is why `connect()` holds nothing
open. This image does not behave that way: MEASURED, with one connection held open and a second
opened beside it, the second was answered in **1 ms**. pymodbus serves clients concurrently.

So this fixture cannot hold that fact, and no test here should claim it does. What this repository
owes a guard for is its own half of it - that the provider holds no connection between reads -
and that is held in `tests/integration/db/modbus-provider.test.ts` against a server that accepts
one client at a time, where a provider that held its socket would hang rather than merely differ.
