# OPC UA captures

What a live server answered, recorded once and replayed by
[`tests/integration/db/opcua-provider.test.ts`](../../integration/db/opcua-provider.test.ts). Nothing
here is hand-written: every file is the output of
[`tests/live/opcua-evidence.ts`](../../live/opcua-evidence.ts), which drives the real provider's own
bridge against the fixture below and writes what came back.

**The fixture.** Microsoft OPC PLC 2.15.10, pinned by digest:

```
mcr.microsoft.com/iotedge/opc-plc:2.15.10@sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c
```

```bash
docker run -d --name opcua-evidence -p 127.0.0.1:54840:50000 \
  mcr.microsoft.com/iotedge/opc-plc:2.15.10@sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c \
  --pn=50000 --autoaccept --unsecuretransport --ut --sph --hn --slownodes=3 --fastnodes=3
bun tests/live/opcua-evidence.ts
```

The port is published on `127.0.0.1` rather than on every interface. `-p 54840:50000` with no host
address is Docker's default of `0.0.0.0`, which puts an unauthenticated OPC UA server (it is started
`--autoaccept --unsecuretransport`) on every interface of whatever machine runs it, CI included. The
capture needs one client on the same host, so the narrower binding costs nothing.

`--hn` is what adds the one historized node, `ns=3;s=HistorianInt32`; without it a history read
answers `BadHistoryOperationUnsupported`, which is also captured.

**THE FLAGS ARE PART OF THE FIXTURE, AND SO ARE ITS FIGURES.** Started exactly as above, this server
holds 6,769 nodes under the Objects folder over 6,865 references and 7,040 distinct browse paths,
the deepest at depth 7, with 41 nodes hanging off more than one parent (so 215 have more than one
path), 168 Methods, a widest level
of 100 children and eight namespaces - re-measured on 12 Oct 2026, and the figures every comment in
`src/lib/db/providers/industrial/opcua/` and every number in `docs/providers/opcua.md` now carry.
Add one flag and they all move: with `--alm` the same image holds 8,753 nodes and nine namespaces,
and the ninth is inserted in the MIDDLE of the array, so two namespace indices shift. An earlier
round's figures (8,756 nodes, 11,004 paths) were measured on such a server and did not reproduce
from the command above, which is why this paragraph exists.

| File | What it holds |
|---|---|
| `endpoints.json` | The seven endpoints the server offers, each with its policy and its certificate's SHA-256 thumbprint, and the URL it ADVERTISES — a container hostname that resolves nowhere outside Docker |
| `limits.json` | The operational limits it publishes: 2,500 nodes per Read and per Browse, 1,000 per HistoryReadData, 10 browse continuation points, 100 history ones |
| `levels.json` | Browse answers, by node id, from the Objects folder down four levels |
| `values.json` | A Read of five nodes asking for the ten attributes `OPCUA_READ_ATTRIBUTES` names - a scalar answers nine of them, `arrayDimensions` being absent: three nodes that answer, the historized one, and one that does not exist |
| `history.json` | A first history page, a valid continuation, the refusal a MISMATCHED window earns, and the refusal a node that keeps no history gives |

**Two of these captures are the measurements the provider is built around.** `values.json` shows
`accessLevel: 3` — read and write — for an anonymous session, which is why the read-only guarantee is
structural rather than a setting. `history.json` shows `BadContinuationPointInvalid` for a
continuation whose window differs from the read that handed out the point, which is why the window is
fixed once per read and travels with every page.
