# MTConnect provider, work in progress

Issue #1722. Read only: the provider sends GET and nothing else.

What is here, and what each file rests on:

| File | Lines | What it is |
|---|---|---|
| `xml.ts` | 468 | The XML reader: attribute and prefix preserving, CDATA and an optional stylesheet instruction accepted, DOCTYPE and ENTITY refused before parsing, and a streaming walker that keeps the `DeviceStream` and `ComponentStream` attributes on a stack |
| `xml-bounds.ts` | 44 | The reader's bounds, each with the measurement it was sized from |
| `model.ts` | 180 | The `probe` answer indexed by `dataItemId`, with the freshness test on `instanceId` and `deviceModelChangeTime` |
| `rows.ts` | 184 | One observation to one row, joining the model for category, type and units |
| `routes.ts` | 220 | The closed route table, nine routes read from the agent's own Swagger, with the six published routes left out and the six refused parameters each carrying its reason |
| `guard.ts` | 347 | Phase 0: everything refused before a socket opens, including the `path` subset |
| `capabilities.ts` | 118 | What the provider declares about itself |

Tests, all against the thirteen answers captured from a real agent rather than against fixtures
written to suit the code: `tests/unit/db/mtconnect/xml.test.ts` (74), `rows.test.ts` (18),
`guard.test.ts` (30), `console-delta.test.ts` (12).

## The three shared lines this provider still needs

None is in this directory, and all three belong to the last step of the provider's PR, because
several other issues queue for the same files.

1. `src/lib/types.ts`: `"mtconnect"` as a member of the `DatabaseType` union.
2. `src/lib/db/factory.ts`: one `case` with a dynamic import.
3. The `queryDialect` union behind `ProviderCapabilities`: `"mtconnect"` as a member.

The third was found by removing a cast rather than by reading the checklist. An earlier draft of
`index.ts` declared `queryDialect: "mtconnect"` behind `as unknown as ProviderCapabilities`, and
with the cast gone the compiler named it at once: that union is closed and it now reads
`... | "opcua" | undefined`, because #1719 added its own member there. The field is optional, so
`getCapabilities()` declares `queryLanguage: "json"` and no dialect until the member lands.

Removing that cast found three more mismatches the cast had been hiding: a container level written
`{ label, plural }` where the type wants `{ id: "catalog" | "schema", label, labelPlural }`, and two
result objects carrying a field of their own invention.

Until the first lands, `capabilities.ts` declares `export type MtconnectType = "mtconnect"` as a
local alias. **That alias exists only because the union line is not in yet.** When the line lands,
delete the alias and its constant and read `DatabaseType` instead; it is two lines in one file. The
alias is recorded here rather than as a `TODO` in the source so that it cannot quietly become
permanent.

## What is not written yet

The provider class itself, the one that extends `BaseDatabaseProvider` and implements its eighteen
abstract members, and the HTTP client that builds a request from the route table over the shared
transport. The pieces they compose are all here: the table, the guard, the reader, the model index
and the row builder.

## The registration surfaces beyond those two lines

`docs/ADDING_A_PROVIDER.md` is the list, and it is long: about sixty cited places, of which seven
are exhaustive `Record<DatabaseType, ...>` maps that refuse to compile without an entry. The engine
counter is deliberately not among this provider's work: it moves once, in whichever provider PR
merges last, rather than six times.
