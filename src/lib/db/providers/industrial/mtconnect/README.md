# MTConnect provider

What each file is for.
The canonical reference is [`docs/providers/mtconnect.md`](../../../../../../docs/providers/mtconnect.md); this is the map of the directory.
Read only: the provider sends GET and nothing else, on the editor's handles and agent mode's alike.

| File | What it holds |
|---|---|
| `routes.ts` | The closed route table, the routes left out with their reasons, the refused parameters and the console dialect |
| `guard.ts` | Phase 0: everything refused before a socket opens, including the `path` subset |
| `connection-options.ts` | The address as dialled: the scheme and TLS material from the SSL / TLS panel, and the Path prefix |
| `client.ts` | One operation, a GET of a route from the table, with the byte caps and the request ceiling |
| `xml.ts` | The XML reader and the streaming walker over observations; DOCTYPE and ENTITY refused before parsing |
| `xml-bounds.ts` | The reader's bounds, each with the measurement it was sized from |
| `model.ts` | The `probe` answer indexed by `dataItemId`, with the freshness test on `instanceId` |
| `rows.ts` | One observation to one row, joined with the model for category, type and units |
| `capabilities.ts` | What the provider declares before any connection |
| `index.ts` | `MTConnectProvider` and the refusal boundary |
| `agent-statement.ts` | Agent mode's reader of one request line: the console's guard, with the list of routes in its refusals |
| `agent-read.ts` | One agent read: the device model read fresh, the request, the budgets and the failure categories |
| `agent-withheld.ts` | The agent's adapter connections, withheld on every agent-mode handle |
| `agent-surface.ts` | What an agent-mode handle answers outside `queryReadOnly` |
