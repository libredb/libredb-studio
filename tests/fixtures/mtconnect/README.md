# MTConnect captures

Taken by `tests/live/mtconnect-evidence.ts` from the compose fixture (`mtconnect` and
`mtconnect-adapter` in `database-compose.yml`). Each file is the agent's answer verbatim: this
provider refuses an XML comment, so nothing may be written into the documents themselves.

The buffer at capture time: firstSequence 1, lastSequence 80, nextSequence 81.

| file | request | bytes |
|---|---|---|
| `probe.xml` | `GET /probe` | 3619 |
| `current.xml` | `GET /current` | 4787 |
| `current-at.xml` | `GET /current?at=75` | 4788 |
| `sample-from.xml` | `GET /sample?from=72&count=5` | 1849 |
| `sample-count-1.xml` | `GET /sample?count=1` | 925 |
| `sample-count-minus.xml` | `GET /sample?count=-5` | 1912 |
| `assets.xml` | `GET /assets` | 911 |
| `asset-tool.xml` | `GET /asset/TOOL-1722` | 911 |
| `current-condition.xml` | `GET /current?path=%2F%2FDataItem%5B%40category%3D%22CONDITION%22%5D` | 1002 |
