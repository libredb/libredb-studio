#!/usr/bin/env python3
"""Prints generated line protocol on stdout for docker/influxdb/seed.sh, which writes it; this script writes nothing.

    bulk.py filelimit [--now SECONDS]   the file-limit fixture: measurement home in database home, two rooms, one
                                        point per room every 4 hours over the last 80 hours (21 timestamps, each in
                                        its own 10-minute gen1 window, so each persists its own Parquet file)
    bulk.py bench [--now SECONDS]       database bench: measurement bulk (100 hosts x 20,000 seconds = 2,000,000
                                        points, one tag and five fields) and measurement wide200 (one tag and 200
                                        float fields, 2,000 points), both ending at --now

Timestamps are in seconds; --now defaults to the current time. The values are a function of the timestamp and the
series alone, so a second run over the same --now prints the same text.
"""

import argparse
import sys
import time

FILELIMIT_STEP_HOURS = 4
FILELIMIT_POINTS = 21
BULK_HOSTS = 100
BULK_SECONDS = 20_000
WIDE_FIELDS = 200
WIDE_POINTS = 2_000


def filelimit(now: int, out) -> None:
    for k in range(FILELIMIT_POINTS):
        stamp = now - k * FILELIMIT_STEP_HOURS * 3600
        for index, room in enumerate(("Kitchen", "Living\\ Room")):
            temp = 20 + (k * 7 + index * 3) % 50 / 10
            hum = 35 + (k * 3 + index) % 20 / 10
            out.write(f"home,room={room} temp={temp:.1f},hum={hum:.1f},co={(k + index) % 30}i {stamp}\n")


def bench(now: int, out) -> None:
    start = now - BULK_SECONDS
    for second in range(BULK_SECONDS):
        stamp = start + second
        for host in range(BULK_HOSTS):
            seed = second * BULK_HOSTS + host
            out.write(
                f"bulk,host=h{host:02d} f1={(seed % 1000) / 10:.1f},f2={(seed % 997) / 7:.4f},"
                f"f3={(seed % 101) - 50.5:.1f},i1={(seed * 7) % 1000}i,i2={second}i {stamp}\n"
            )
    start = now - WIDE_POINTS
    for point in range(WIDE_POINTS):
        fields = ",".join(f"f{field:03d}={(point * WIDE_FIELDS + field) % 1000 / 10:.1f}" for field in range(WIDE_FIELDS))
        out.write(f"wide200,host=h{point % 10} {fields} {start + point}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("filelimit", "bench"))
    parser.add_argument("--now", type=int, default=int(time.time()))
    arguments = parser.parse_args()
    (filelimit if arguments.mode == "filelimit" else bench)(arguments.now, sys.stdout)


if __name__ == "__main__":
    main()
