# The Sparkplug B fixture

Two services, and they are two different KINDS of fixture:

| part | class | what that means here |
|---|---|---|
| `sparkplug`, the broker | **A, third-party image pinned by digest** | `eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21`, loopback only. The tag alone would not do: the same tag is a different image tomorrow. |
| `sparkplug-publisher`, the edge node | **B, independently written producer, declared below** | `publisher.py`, written against the specification and not against this repository's code. The declaration is the next section, and it is the part that must survive. |

A broker with nothing on it exercises nothing, so the second service is what makes the first
one a fixture.

The two services are delivered in `docker/sparkplug/compose-service.yml` and land in
`database-compose.yml` from there, so that shared file is written by one hand. The file runs on
its own in the meantime:

```
docker compose -f docker/sparkplug/compose-service.yml up -d
```

The broker listens on `127.0.0.1:1884`. In Studio: Host `127.0.0.1`, Port `1884`, and **Group**
either empty, for every group, or one of the two group names below.

## The reference implementation, and why this is still class B

`docs/providers/sparkplug.md` names the reference encoder in its first section: Eclipse Tahu
`sparkplug-payload` 1.0.3. It exists, it is usable, and it was measured rather than assumed:

| | measured |
|---|---|
| availability | npm, `sparkplug-payload@1.0.3`, EPL-2.0, integrity `sha512-JAQSyuHVQQe/LzIlJdcIaD1F1c+rbXoolII3H1whQkhuZ96+G53RoPWqP9zCPZYFjvfSMHnQNIedGIZw/zjHJw==` |
| dependencies | `protobufjs ^6.11.3`, `long ^4`, `@types/long ^4` |
| Python equivalent | none worth using: PyPI `tahu` is 0.1.2, carries no licence metadata and pins `protobuf==3.19.1` from 2021, so it is not the 1.0.3 the document names |
| what it covers | PAYLOADS only. Tahu encodes no MQTT packet, so the CONNECT and PUBLISH framing stays hand-written whichever encoder produces the payload |

**And the bytes agree, exactly.** The same three payload shapes were encoded by Tahu 1.0.3 and by
`publisher.py` with the timestamps fixed, and compared as hex:

| payload | result |
|---|---|
| a birth: `bdSeq` Int64, `Temperature` Double with alias, `ShiftName` String with alias | byte for byte identical |
| a data message: four metrics by ALIAS ONLY, Double, Int64, Boolean, String | byte for byte identical |
| a metric declared null with `is_null` | byte for byte identical |

So this file's reading of the specification and the reference implementation's reading do not
differ, which is the only thing a reference encoder could have told us here. Moving the fixture
onto Tahu would change no byte; it would add a Node runtime and three packages to a container
that today needs neither, and it would still leave the MQTT framing where it is.

## The class B declaration: what this publisher was written WITHOUT

A class B fixture is only worth its class if the declaration says what it did not read. This one:

- **Not `src/lib/db/providers/industrial/sparkplug/encoder.ts`**, and nothing else from `src/`.
  The MQTT CONNECT and PUBLISH packets are built in `publisher.py` by hand.
- **Not an MQTT library**, and not a Sparkplug library. There is no `pip install` in the
  service for that reason: the standard library is the only dependency.
- **Not the provider's protobuf decoder.** Every field number in `publisher.py` comes from the
  Sparkplug B 3.0.0 specification: Payload is 1 timestamp, 2 metrics, 3 seq; Metric is 1 name,
  2 alias, 3 timestamp, 4 datatype, 7 is_null, and 11/13/14/15 for the value arms.
- The capture that feeds the integration test (`tests/live/sparkplug-evidence.ts`) decodes
  nothing either: it records raw packet bytes.

**What it does not imitate, said plainly, because a fixture that is quiet about its edges gets
believed past them.** It publishes at QoS 0 and never at 1 or 2; it registers no Last Will, so
no `NDEATH` arrives when it is killed and the provider's death handling is exercised by unit
tests rather than here; it retains only the certificate topic; it publishes on a fixed two
second cadence with no jitter, no burst and no reconnect; and it never sends a malformed or
truncated payload. None of those was measured against a real edge node: they are absences, not
findings.

**Keep it that way.** A publisher that shared the provider's encoder would share its mistakes,
and the suite would be measuring itself: every value would match because one piece of code
wrote and read it, and no test would notice. If this file ever needs a library, add it to the
READER's tests, never to the publisher.

## What is published, and what each node is there to answer

| topic | what it publishes | the question it answers |
|---|---|---|
| `spBv1.0/SekoyaPlant/NBIRTH/Line1` | a live birth, six metrics | are names, aliases and datatypes read back |
| `spBv1.0/SekoyaPlant/DBIRTH/Line1/Press01` | a device birth, four metrics | is a device told apart from its node |
| `spBv1.0/SekoyaPlant/NDATA/Line1`, `DDATA/Line1/Press01` | values under ALIASES ONLY | is the certificate load-bearing (6.4.6) |
| `spBv1.0/SekoyaPlant/NDATA/Line2` | data under alias 7, and NO birth at all | does the reader say it cannot name what it saw |
| `$sparkplug/certificates/spBv1.0/SekoyaPlant/NBIRTH/Line3` | a STORED certificate, retained | the birth-time path, and the sentence that says a stored value may be stale (10.1.4) |
| `spBv1.0/SekoyaPlant/NBIRTH/Line4` | a live birth and no data at all | the values a birth carries are the only reading there is (4.1.1) |
| `spBv1.0/AnkaraPlant/NBIRTH/Mixer1`, `NDATA/Mixer1` | a second GROUP | does an empty Group field really read every group |

The values, which are fixed so they can be recognised on sight:

| node | metric | alias | datatype | value |
|---|---|---|---|---|
| Line1 | `Temperature` | 1 | Double | `42.5` |
| Line1 | `CycleCount` | 2 | Int64 | `1234567890123` |
| Line1 | `MotorRunning` | 3 | Boolean | `true` |
| Line1 | `BatchName` | 4 | String | `BATCH-7781` |
| Line1 | `Properties/Hardware Make` | none | String | `Sekoya`, birth only |
| Line1 | `Node Control/Rebirth` | none | Boolean | `false`, birth only |
| Press01 | `PressForce` | 10 | Double | `118.25` |
| Press01 | `StrokeCount` | 11 | Int64 | `98765` |
| Press01 | `GripperClosed` | 12 | Boolean | `false` |
| Press01 | `RecipeName` | 13 | String | `RCP-ALPHA` |
| Line3 | `Humidity` | 20 | Double | `61`, from the stored certificate |
| Line4 | `Temperature` | 40 | Double | `99.9`, birth only |
| Line4 | `ShiftName` | 41 | String | `NIGHT-SHIFT`, birth only |
| Mixer1 | `MixerSpeed` | 50 | Int64 | `1450` |

## Reading the wire without this repository's decoder

`read-topic.py` prints what a topic carries, walking the protobuf with its own varint reader. It
is a diagnostic and nothing depends on it: no test imports it and no step runs it. It exists for
the one question worth asking when a value is missing from the screen - was it on the wire at all.

```
python3 docker/sparkplug/read-topic.py --topic 'spBv1.0/SekoyaPlant/NBIRTH/Line4'
```

On 14 October 2026 the answer was yes, and that is what sent the search into the fold rather than
into the publisher: the birth carried `Temperature` 99.9 and `ShiftName` "NIGHT-SHIFT" while both
rendered empty.

## Two deliberate departures from a real plant, both measured

**The birth is republished every two seconds.** A real edge node publishes its birth once and
then stays quiet, which would leave a reader joining later with data it cannot name. The
fixture republishes so that any read window meets a certificate.

**The data sequence increases across rounds.** It does not restart at each birth, because a
birth every two seconds would put a gap between two consecutive data messages and the provider
would report it - correctly, and about the fixture rather than about the product. The gap is
still reachable on purpose: `publisher.py --gaps`.
