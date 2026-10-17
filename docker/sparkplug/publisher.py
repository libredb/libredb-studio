#!/usr/bin/env python3
"""A Sparkplug B edge node, published onto the fixture broker.

WHY THIS IS WRITTEN BY HAND, AND WHY IT MUST STAY THAT WAY. Both the protobuf wire and the
MQTT packets are built in this file, with no library and with nothing imported from `src/`.
A publisher that encoded with the provider's own `encoder.ts`, or that decoded with a library
the provider also used, would agree with the provider whether or not either agreed with the
specification: the two would share their mistakes and the fixture would be measuring itself.
Every field number below comes from the Sparkplug B 3.0.0 specification, and the standard
library is the only dependency, so the service needs no `pip install` either.

WHAT IT PUBLISHES, and each one answers a question the provider is asked:

  SekoyaPlant/Line1            a live birth, a device birth and data, so names, aliases and
  SekoyaPlant/Line1/Press01    values can all be read back; data carries ALIASES ONLY, which
                               is how a real edge node publishes and what makes the
                               certificate's resolution load-bearing
  SekoyaPlant/Line2            data under an alias and NO birth at all, so the reader has to
                               say it cannot name what it saw
  SekoyaPlant/Line3            a STORED certificate on `$sparkplug/certificates/...`, retained,
                               and nothing else: the birth-time path
  SekoyaPlant/Line4            a live birth and no data at all: the values a birth carries are
                               the only reading there is
  AnkaraPlant/Mixer1           a second group, which is what makes "leave Group empty to read
                               every group" a claim a test can refuse

The data sequence numbers increase across rounds rather than restarting at each birth. A real
plant does not republish its birth every two seconds; this one does, so a reader that joins
late still meets a certificate, and restarting the sequence each round would show the reader a
gap between two consecutive data messages. The gap behaviour is still reachable, with --gaps.
"""

import argparse
import os
import socket
import struct
import sys
import time

GROUP = "SekoyaPlant"
SECOND_GROUP = "AnkaraPlant"
NODE, SILENT_NODE, STORED_NODE, BIRTH_ONLY_NODE = "Line1", "Line2", "Line3", "Line4"
DEVICE = "Press01"
SECOND_NODE = "Mixer1"

# Sparkplug B 3.0.0 datatype codes (6.4.16).
INT64, DOUBLE, BOOLEAN, STRING = 4, 10, 11, 12


# -- protobuf, by hand ------------------------------------------------------------------

def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        digit = value & 0x7F
        value >>= 7
        out.append(digit | (0x80 if value else 0))
        if not value:
            return bytes(out)


def key(field: int, wire: int) -> bytes:
    return varint((field << 3) | wire)


def pb_varint(field: int, value: int) -> bytes:
    return key(field, 0) + varint(value)


def pb_bool(field: int, value: bool) -> bytes:
    return key(field, 0) + varint(1 if value else 0)


def pb_bytes(field: int, raw: bytes) -> bytes:
    return key(field, 2) + varint(len(raw)) + raw


def pb_string(field: int, text: str) -> bytes:
    return pb_bytes(field, text.encode("utf-8"))


def pb_double(field: int, value: float) -> bytes:
    return key(field, 1) + struct.pack("<d", value)


def now_ms() -> int:
    return int(time.time() * 1000)


def metric(name=None, alias=None, datatype=None, value=None, timestamp=None, is_null=False) -> bytes:
    """One Metric: 1 name, 2 alias, 3 timestamp, 4 datatype, 7 is_null, 11/13/14/15 the value."""
    out = b""
    if name is not None:
        out += pb_string(1, name)
    if alias is not None:
        out += pb_varint(2, alias)
    out += pb_varint(3, timestamp if timestamp is not None else now_ms())
    if datatype is not None:
        out += pb_varint(4, datatype)
    if is_null:
        out += pb_bool(7, True)
    elif datatype == DOUBLE:
        out += pb_double(13, value)
    elif datatype == INT64:
        out += pb_varint(11, value)
    elif datatype == BOOLEAN:
        out += pb_bool(14, value)
    elif datatype == STRING:
        out += pb_string(15, value)
    return out


def payload(metrics, seq: int) -> bytes:
    """One Payload: 1 timestamp, 2 metrics (repeated), 3 seq."""
    out = pb_varint(1, now_ms())
    for one in metrics:
        out += pb_bytes(2, one)
    return out + pb_varint(3, seq)


# -- MQTT 3.1.1, by hand ----------------------------------------------------------------

class Broker:
    def __init__(self, host: str, port: int, client_id: str) -> None:
        self.socket = socket.create_connection((host, port), timeout=10)
        variable = b"\x00\x04MQTT\x04\x02\x00\x3c"  # protocol name, level 4, clean session, keepalive 60
        body = variable + struct.pack(">H", len(client_id)) + client_id.encode()
        self.socket.sendall(b"\x10" + varint(len(body)) + body)
        acknowledgement = self.socket.recv(4)
        if len(acknowledgement) < 4 or acknowledgement[0] != 0x20 or acknowledgement[3] != 0x00:
            raise SystemExit(f"the broker refused the connection: {acknowledgement!r}")

    def publish(self, topic: str, data: bytes, retain: bool = False) -> None:
        encoded = topic.encode()
        body = struct.pack(">H", len(encoded)) + encoded + data
        self.socket.sendall(bytes([0x30 | (1 if retain else 0)]) + varint(len(body)) + body)

    def close(self) -> None:
        try:
            self.socket.sendall(b"\xe0\x00")
            self.socket.close()
        except OSError:
            pass


# -- what the plant publishes -----------------------------------------------------------

NODE_METRICS = (
    # No alias, so no data message can carry it: its only reading is the one the birth holds.
    ("Node Control/Rebirth", None, BOOLEAN, False),
    ("Properties/Hardware Make", None, STRING, "Sekoya"),
    ("Temperature", 1, DOUBLE, 42.5),
    ("CycleCount", 2, INT64, 1234567890123),
    ("MotorRunning", 3, BOOLEAN, True),
    ("BatchName", 4, STRING, "BATCH-7781"),
)
DEVICE_METRICS = (
    ("PressForce", 10, DOUBLE, 118.25),
    ("StrokeCount", 11, INT64, 98765),
    ("GripperClosed", 12, BOOLEAN, False),
    ("RecipeName", 13, STRING, "RCP-ALPHA"),
)
BIRTH_ONLY_METRICS = (
    ("Temperature", 40, DOUBLE, 99.9),
    ("ShiftName", 41, STRING, "NIGHT-SHIFT"),
)
STORED_METRICS = (("Humidity", 20, DOUBLE, 61.0),)
SECOND_GROUP_METRICS = (("MixerSpeed", 50, INT64, 1450),)


def birth(rows, bd_seq=None):
    out = [] if bd_seq is None else [metric("bdSeq", None, INT64, bd_seq)]
    return out + [metric(name, alias, datatype, value) for name, alias, datatype, value in rows]


def data(rows):
    """Aliases only, with no names: 6.4.6 allows either, and a real edge node sends the alias."""
    return [metric(None, alias, datatype, value) for _, alias, datatype, value in rows if alias is not None]


def log(*parts: object) -> None:
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish Sparkplug B traffic onto the fixture broker")
    parser.add_argument("--host", default=os.environ.get("SPARKPLUG_BROKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SPARKPLUG_BROKER_PORT", "1883")))
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between rounds")
    parser.add_argument("--rounds", type=int, default=0, help="0 publishes until stopped")
    parser.add_argument(
        "--gaps",
        action="store_true",
        help="restart the data sequence at every birth, which shows a reader the sequence gap it reports",
    )
    options = parser.parse_args()

    broker = Broker(options.host, options.port, "sparkplug-fixture-publisher")
    log(f"connected to {options.host}:{options.port}")

    # The stored certificate is retained, and only this one is: `$sparkplug/certificates/...` is
    # the topic a Sparkplug-aware broker keeps a copy on (10.1.4), and a reader that arrives
    # later is meant to find it there. A retained NBIRTH on the ordinary topic would be a
    # different thing, and the specification does not ask for one.
    stored_topic = f"$sparkplug/certificates/spBv1.0/{GROUP}/NBIRTH/{STORED_NODE}"
    broker.publish(stored_topic, payload(birth(STORED_METRICS, bd_seq=0), seq=0), retain=True)
    log(f"retained stored certificate on {stored_topic}")

    node_seq, silent_seq, rounds = 2, 2, 0
    try:
        while options.rounds == 0 or rounds < options.rounds:
            rounds += 1
            if options.gaps:
                node_seq = 2
            broker.publish(f"spBv1.0/{GROUP}/NBIRTH/{NODE}", payload(birth(NODE_METRICS, bd_seq=rounds % 256), seq=0))
            broker.publish(f"spBv1.0/{GROUP}/DBIRTH/{NODE}/{DEVICE}", payload(birth(DEVICE_METRICS), seq=1))
            broker.publish(f"spBv1.0/{GROUP}/NDATA/{NODE}", payload(data(NODE_METRICS), seq=node_seq % 256))
            broker.publish(
                f"spBv1.0/{GROUP}/DDATA/{NODE}/{DEVICE}", payload(data(DEVICE_METRICS), seq=(node_seq + 1) % 256)
            )
            node_seq += 2

            broker.publish(
                f"spBv1.0/{GROUP}/NDATA/{SILENT_NODE}",
                payload([metric(None, 7, DOUBLE, 7.75)], seq=silent_seq % 256),
            )
            silent_seq += 1

            broker.publish(f"spBv1.0/{GROUP}/NBIRTH/{BIRTH_ONLY_NODE}", payload(birth(BIRTH_ONLY_METRICS, bd_seq=0), seq=0))

            broker.publish(
                f"spBv1.0/{SECOND_GROUP}/NBIRTH/{SECOND_NODE}", payload(birth(SECOND_GROUP_METRICS, bd_seq=0), seq=0)
            )
            broker.publish(
                f"spBv1.0/{SECOND_GROUP}/NDATA/{SECOND_NODE}",
                payload(data(SECOND_GROUP_METRICS), seq=silent_seq % 256),
            )

            if rounds % 10 == 1:
                log(f"round {rounds}: {NODE} birth and data, {SILENT_NODE} uncertified data, {BIRTH_ONLY_NODE} birth only")
            if options.rounds == 0 or rounds < options.rounds:
                time.sleep(options.interval)
    except KeyboardInterrupt:
        pass
    finally:
        broker.close()
        log(f"stopped after {rounds} rounds")


if __name__ == "__main__":
    sys.exit(main())
