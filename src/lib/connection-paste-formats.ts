import { CONNECTION_PICKER_ORDER } from "@/lib/db/connection-form";
import { CONNECTION_STRING } from "@/lib/db/connection-string";

/**
 * The texts the connection dialog's Paste URL box reads, as one phrase for its hint and its refusal alike (SF-024):
 * two copies of this list drifted once, and the refusal named no Snowflake form while the hint did. Each engine names
 * its own forms in the `formats` of its row's `paste`, beside its provider, and they are listed in the order the
 * engine picker lists the engines.
 *
 * An engine whose row reads no paste is absent: Elasticsearch, OpenSearch and Trino are addressed by host and port
 * like Druid, and `http(s)://` already resolves to ClickHouse; DuckDB, SQLite and the embedded store are file-based,
 * and the Paste URL control is never drawn for them.
 */
export const PASTE_FORMATS_TEXT = CONNECTION_PICKER_ORDER.flatMap(
  (type) => CONNECTION_STRING[type].paste?.formats ?? [],
).join(", ");
