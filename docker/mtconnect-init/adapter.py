#!/usr/bin/env python3
"""The device behind the MTConnect agent.

An agent on its own reports UNAVAILABLE for every data item: it is a server that republishes what
an adapter tells it. This script is that adapter, speaking SHDR (the agent's own ingest protocol)
on 7878, so a test reads values that travelled the whole way rather than values an agent invented.

Every value is chosen to be unmistakable on a screen: the positions begin 1722, 1723 and 1724,
which is the issue number, and the program name carries it too.

Logging goes to stdout, where `docker logs` collects it: the container filesystem is read only.
"""

import datetime
import socket
import sys
import threading
import time

# The three positions the X axis reports, in order, one every PERIOD seconds. Three rather than one
# so that a `sample` read has something to order, and fixed rather than random so that a screen can
# be read against this list.
POSITIONS = (1722.5, 1723.5, 1724.5)
PERIOD = 10
PORT = 7878


def log(line: str) -> None:
    print(f"{datetime.datetime.now(datetime.UTC).isoformat()} {line}", flush=True)


def stamp() -> str:
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def feed(conn: socket.socket, addr: object) -> None:
    log(f"agent connected from {addr}")
    index = 0
    try:
        conn.sendall(f"{stamp()}|availability|AVAILABLE\n".encode())
        conn.sendall(f"{stamp()}|execution|ACTIVE\n".encode())
        conn.sendall(f"{stamp()}|program|LIBREDB-TEST.NC\n".encode())
        conn.sendall(f"{stamp()}|Sspeed|3600\n".encode())
        # A CONDITION carries five fields after the level: native code, severity, qualifier, text.
        conn.sendall(f"{stamp()}|system|warning|SYS-1722|2|HIGH|Fixture warning for issue 1722\n".encode())
        # One asset, so the assets routes have something to answer with.
        tool = (
            '<CuttingTool assetId="TOOL-1722" toolId="T1722" serialNumber="SN-1722" '
            'manufacturers="LibreDB Fixture"><CuttingToolLifeCycle>'
            "<CutterStatus><Status>NEW</Status></CutterStatus>"
            '<ToolLife type="MINUTES" countDirection="UP" limit="1722">42</ToolLife>'
            "</CuttingToolLifeCycle></CuttingTool>"
        )
        conn.sendall(f"{stamp()}|@ASSET@|TOOL-1722|CuttingTool|{tool}\n".encode())
        log("sent availability, execution, program, spindle speed, condition and asset TOOL-1722")
        while True:
            position = POSITIONS[index % len(POSITIONS)]
            conn.sendall(f"{stamp()}|Xposition|{position}\n".encode())
            if index % 6 == 0:
                log(f"sent Xposition={position}")
            index += 1
            time.sleep(PERIOD)
    except OSError as error:
        log(f"agent disconnected: {error}")
    finally:
        conn.close()


def main() -> int:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", PORT))
    server.listen(5)
    log(f"adapter listening on {PORT}")
    while True:
        conn, addr = server.accept()
        threading.Thread(target=feed, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
