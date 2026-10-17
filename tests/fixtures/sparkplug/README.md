# The Sparkplug B capture

`plant.json` holds what Eclipse Mosquitto sent, byte for byte, while the fixture of
`docker/sparkplug/` was running. `tests/integration/db/sparkplug-provider.test.ts` replays those
packets over a loopback socket, so the provider's own parser, fold and row builder run against
the bytes a real broker produced rather than against bytes a test wrote.

| field | what it is |
|---|---|
| `broker` | the image digest the packets came from; a test holds the capture to it |
| `publisher` | the edge node that produced them, `docker/sparkplug/publisher.py` |
| `capturedAt` | the day it was taken |
| `topics` | every topic in the capture, sorted; a test names the eight that must be there |
| `packets` | each PUBLISH as `{ topic, hex }`, the whole packet and not only its payload |

## Why the capture decodes nothing

`tests/live/sparkplug-evidence.ts` subscribes as MQTT 5, which is the version the provider
connects with, and writes the raw bytes down. It reads no payload and knows no Sparkplug field
number. Together with the publisher's own declaration (`docker/sparkplug/README.md`), that
means neither end of this fixture shares code with the provider that reads it.

## Retaking it

With the fixture up:

```
docker compose -f docker/sparkplug/compose-service.yml up -d
bun tests/live/sparkplug-evidence.ts --seconds 8
```

The script refuses to write an empty capture: a fixture with no packets would let every
assertion in the integration test pass on no evidence at all.

## The reference payload

`tahu-datatypes.json` is one payload that Eclipse Tahu `sparkplug-payload` 1.0.3 encoded, with
every datatype the provider reads. `tests/unit/db/sparkplug/reference-encoder.test.ts` reads it
through the production path and imports Tahu nowhere, so the test cannot drift with the package.

It carries its own `regenerateWith`, and `record-tahu-datatypes.mjs` beside it is the script
those lines run: Tahu is installed in a scratch directory, never here, so the reference encoder
never becomes a dependency of this repository. A recording no one can re-make is a recording
the repository owns without understanding.

Three facts measured against that package on 2026-10-13 and checked again on 2026-10-15, with
the bytes read by a parser that is not Tahu's: Int8 -1 arrives as `int_value` 4294967295,
Int16 -32768 as 4294934528, and UInt32 travels in `long_value` rather than `int_value`. Each of
them produces a wrong NUMBER rather than an error if a decoder reads the field that is set.
