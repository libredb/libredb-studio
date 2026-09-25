# Apache Kafka Provider

> Apache Kafka support for LibreDB Studio, read-only over the Kafka protocol through `@platformatic/kafka`.
> The editor text is a JSON read request, declared `queryLanguage: "json"` with `queryDialect: "kafka"`.
> This document is the single reference for the Kafka provider; the sections around this one are written with the rest of its documentation (#1088).

## Object edit (#789)

Nothing to write, and the absence is the product's, not the engine's.
Kafka has writes: a producer appends records, and the admin API creates and deletes topics, changes configs and resets a group's offsets.
This product declines them in v1 by decision (#1088, section 2), so no kind declares `acceptsRowWrites` or `acceptsSourceEdits`, and the provider never produces, commits an offset, joins a group or creates a topic.
The absence is `kafka`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` is what holds that entry and this section together.
