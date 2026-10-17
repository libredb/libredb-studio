# SNMP fixture

A real Net-SNMP agent, pinned twice: the base image by digest and the two packages by version.

## What it answers

The values are chosen to be RECOGNISABLE, so that a value on the screen cannot have come from
anywhere else: `sysName` is `live-test-agent`, `sysLocation` is `1721-live-test`, and the
constants under `netSnmpPlaypen` (1.3.6.1.4.1.8072.9999.9999) are 1000, 1001, 1002, the string
`live-test-value`, a gauge of 4242, a counter of 123456789 and a TimeTicks of 360000. The
three-row table under `...9999.10.1` holds `sensor-one`, `sensor-two` and `sensor-three` beside
1000, 1001 and 1002.

The community is `libredb-live` and it is ENFORCED: a wrong community is answered with silence,
which is what SNMP does. This matters for the tests. The first agent this fixture replaced was
macOS's own snmpd, whose build carries no access control module: `rocommunity`, `group`, `view`
and `access` were all "unknown token" and the agent answered EVERY community. A test suite run
against it would have passed while the provider sent the wrong secret.

There is no writable community. The provider never writes, and the fixture cannot be written to.

## Running it

    docker compose -f database-compose.yml --profile snmp up -d snmp
    snmpwalk -v2c -c libredb-live 127.0.0.1:1161 1.3.6.1.4.1.8072.9999.9999

## Why not a hand-written agent

The provider's client is this repository's own code over `node:dgram`. An agent written here would
share its decoder, and a defect both carried would be invisible. The defect this fixture caught on
14 October 2026 is exactly that kind: a GetBulk whose max-repetitions is zero, which a conforming
agent answers with an empty varbind list.
