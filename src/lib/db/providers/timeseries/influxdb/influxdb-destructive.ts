import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  INFLUXQL_DESTRUCTIVE_OPERATIONS,
  INFLUXQL_MAX_TEXT_BYTES,
  influxqlRefusal,
  readInfluxqlOperations,
} from "@/lib/db/providers/timeseries/influxdb/influxql-policy";

/**
 * InfluxDB's row of the confirmation gate's vocabulary (InfluxDB spec 5.7).
 *
 * The browser-safe InfluxQL policy the provider runs reads the text, so what asks and what runs are one reading. An
 * allowed statement only reads, so nothing asks; what the policy refuses (a write, `INTO`, a second statement, a
 * lexical fault) the editor refuses before anything is sent, and on 1.x and 2.x that policy is the only boundary
 * before `DROP DATABASE`.
 */
export const INFLUXDB_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: INFLUXQL_DESTRUCTIVE_OPERATIONS,
  read: readInfluxqlOperations,
  decidesAlone: true,
  // A statement carries tag values and filters, so no InfluxQL statement is posted for an AI analysis (R21).
  safetyAnalysis: false,
  refuse: influxqlRefusal,
  maxTextBytes: INFLUXQL_MAX_TEXT_BYTES,
};
