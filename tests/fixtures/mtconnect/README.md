# MTConnect captures

Taken by `tests/live/mtconnect-evidence.ts` from the compose fixture (`mtconnect` and
`mtconnect-adapter` in `database-compose.yml`). Each file is the agent's answer verbatim: this
provider refuses an XML comment, so nothing may be written into the documents themselves.

Taken from `mtconnect/agent:2.8.0.4@sha256:c42f90850ab70d65ae5e73b14392b3041ed51065bd7bf287658db6f7260df641`, whose Header reports version
`2.8.0.4`.

The buffer at capture time: firstSequence 1, lastSequence 50, nextSequence 51.

| file | request | bytes |
|---|---|---|
| `probe.xml` | `GET /probe` | 3619 |
| `current.xml` | `GET /current` | 4789 |
| `current-at.xml` | `GET /current?at=45` | 4789 |
| `sample-from.xml` | `GET /sample?from=42&count=5` | 1913 |
| `sample-count-1.xml` | `GET /sample?count=1` | 925 |
| `sample-count-minus.xml` | `GET /sample?count=-5` | 1869 |
| `assets.xml` | `GET /assets` | 911 |
| `asset-tool.xml` | `GET /asset/TOOL-1722` | 911 |
| `current-condition.xml` | `GET /current?path=%2F%2FDataItem%5B%40category%3D%22CONDITION%22%5D` | 1002 |
