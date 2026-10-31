# OPC UA provider

What each file is for. The canonical reference is
[`docs/providers/opcua.md`](../../../../../../docs/providers/opcua.md); this is the map of the
directory. Every bound in `constants.ts` is a measurement taken against four server stacks on
2026-10-11/12, and the measurement is named beside it.

| File | What it holds |
|---|---|
| `constants.ts` | Every number and fixed name, each with the server it was measured on |
| `client.ts` | The eight services this provider can call, and nothing else (O-S1) |
| `session.ts` | This provider's rules over the library, stated without importing it |
| `library.ts` | The one module that imports `node-opcua-client`; three library defaults overridden |
| `hostname-guard.ts` | One guard over `dns.lookupService`, installed before the library loads |
| `session-pool.ts` | One session per connection, opened once, closed on every path out; a session the server has forgotten is replaced once |
| `connection.ts` | The dialog's fields read into options, every refusal before the dial |
| `security.ts` | Endpoint, identity policy, certificate pin |
| `pki.ts` | Where the client's own key pair and trust store live |
| `node-id.ts` | Node-id grammar, and the escaped browse path the Keys panel walks |
| `limits.ts` | Chunk sizes: ours first, the server's only when smaller and real |
| `key-scan.ts` | One level is one Browse; the capability the panel reads; the page is chosen before the folder flag is measured |
| `walk.ts` | The bounded whole-tree walk, which no UI action calls |
| `read-request.ts` | The JSON read request, parsed strictly |
| `history.ts` | Raw history, two paging strategies, bounded by a value cap |
| `results.ts` | Rows: one per node, or one per historical value |
| `objects.ts` | The `node` kind (`enumeratedBy: "key-browser"`), value rendering, AccessLevel decoding |
| `errors.ts` | Status codes to sentences, written from four servers' answers |
| `labels.ts` | The provider's labels |
| `capabilities.ts` | What is declared before any connection |
| `agent-statement.ts` | The agent's reader: the console's two reads and a one-level browse, refused before anything is sent otherwise |
| `agent-withheld.ts` | The nodes agent mode never reads, by node id, and the walk under them before every agent read |
| `agent-units.ts` | Each value's engineering units and EU range, read from the node's own properties, never guessed |
| `agent-read.ts` | One agent read on its own session, through a client of the read services alone, budgets refused rather than cut |
| `agent-surface.ts` | What an agent-mode handle answers outside `queryReadOnly`: each reading's reason |
| `index.ts` | `OpcuaProvider` |

## The one rule this directory is built around

`client.ts` names eight read services and `library.ts` is the only module that may import
`node-opcua-client`. `tests/unit/db/opcua/seam.test.ts` asserts both. A caller that wanted to write
would have to widen `client.ts` first, which is a reviewable change rather than a forgettable one.
`session.ts` states the rules over the bridge and imports no library, so a test of those rules runs
without the library in its import graph — which matters, because importing it resolves this host's
name and can throw (see `hostname-guard.ts`).

## Measurements that shaped these files

- A batch of 100 nodes kills the channel, not the request: an answer over the client's own 2 MiB
  limit closes it and every later request on that session fails. Hence 20 per Browse.
- Two of four servers publish an operation limit they do not enforce, and one publishes 0 for eight
  limits. Hence our own bound first.
- One BrowseName on the first fixture contains `/ : . \ | ; =` at once, so a path key escapes the
  separator rather than choosing one.
- 41 of 6,769 nodes have more than one PARENT, and 215 therefore have more than one PATH, giving
  7,040 paths in all. More rows than nodes is correct.
- asyncua never hands back a history continuation point, so paging falls back to the timestamp.
- The product image's `HOME` is `/nonexistent` and cannot be created, so the LIBRARY's own default
  PKI root can never be used. The root defaults to `<data directory>/opcua-pki` instead, and
  `LIBREDB_OPCUA_PKI_ROOT` overrides it: requiring the variable meant the engine could not be
  connected at all in a default install, which a browser run measured.
