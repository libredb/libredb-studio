# MTConnect fixtures, agent 2.8.0.3

Provenance, as `tests/fixtures/rabbitmq/` keeps its own.

Every file in this directory is a verbatim answer from the MTConnect Institute's public demo agent
at `https://demo.mtconnect.org`, captured on 2026-10-13 between 00:27 and 00:30 UTC with
`Accept: application/xml` and no credentials. The agent reported `version="2.8.0.3"` and
`instanceId="1791206842"` in every Header, so all thirteen files come from one agent instance.
Nothing was edited: the bytes are as received, including the `<?xml-stylesheet?>` instruction the
agent emits when styles are configured.

The suite never calls that host. These files are the captured answers the integration layer
replays, and the live check captures its own from the pinned image.

| File | Request | Bytes | Why it is here |
|---|---|---|---|
| `probe.xml` | `GET /probe` | 46,413 | MTConnectDevices root; 12 elements deep, 1,658 attributes over 749 elements |
| `current.xml` | `GET /current` | 41,539 | MTConnectStreams root; 244 observations, one per data item |
| `current-path-condition.xml` | `GET /current?path=//DataItem[@category="CONDITION"]&count=2` | 7,348 | A filtered read, and the evidence that `count` is ignored on `current` |
| `sample-count-1.xml` | `GET /sample?count=1` | 942 | The health read: smallest answer carrying a full Header |
| `sample-count-200.xml` | `GET /sample?count=200` | 27,628 | A forward page |
| `sample-count-negative.xml` | `GET /sample?count=-3` | 1,522 | A backward page: `nextSequence` one below the oldest returned |
| `sample-from-next-sequence.xml` | `GET /sample?from=<nextSequence>` | 14,931 | A read at the top of the buffer on a live agent |
| `assets.xml` | `GET /assets` | 57,192 | MTConnectAssets root, 66 cutting tools. **Carries no `<?xml-stylesheet?>`**, while probe, current and sample do: the instruction is per document, not per agent |
| `error-out-of-range.xml` | `GET /sample?from=1` | 838 | Typed `OutOfRange`, whose `QueryParameter` carries `Minimum` and `Maximum` |
| `error-invalid-parameter-value.xml` | `GET /sample?count=abc` | 857 | Typed `InvalidParameterValue`, whose `QueryParameter` carries `Format` and `Type` instead |
| `error-invalid-uri.xml` | `GET /Probe` | 690 | Typed `InvalidURI`. Its message carries the caller's address, so agent error text can name network topology |
| `error-asset-not-found.xml` | `GET /asset/NOPE-YOK` | 750 | Typed `AssetNotFound`, which also carries `<AssetId>` |
| `error-invalid-xpath.xml` | `GET /current?path=//DataItem[` | 760 | Typed `InvalidXPath` |

All five error documents share the `MTConnectError` root, an `<Errors>` wrapper even for one
error, and a Header with no sequence window.
