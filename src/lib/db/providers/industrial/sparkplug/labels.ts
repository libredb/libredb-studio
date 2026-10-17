/**
 * The Sparkplug provider's labels.
 *
 * Pure, and shipped to the browser: `getLabels()` answers before any connection, through
 * `POST /api/db/provider-meta`. Every sentence that names what the panel cannot do says why in the
 * same breath, because a disabled control with no reason reads as a defect.
 *
 * THE WORDING AVOIDS TWO CLAIMS ON PURPOSE. The Sparkplug Trademark Guidelines 1.0 count
 * "Sparkplug" and "Sparkplug Compatible" among the Sparkplug Marks, and "Sparkplug Compatible" is
 * limited to products that pass the TCK. Nothing here says this product is a Sparkplug Host
 * Application either: a Host Application MUST publish STATE (specification 1.4.1, 10.1.2), and
 * this provider publishes nothing at all. The naming question above the type-id itself is the
 * maintainer's and is still open.
 */
import type { ProviderLabels } from "@/lib/db/types";

/**
 * An edge node declares metrics, and a metric is the row. There is no table: the birth certificate
 * is the schema, and what it declares are the columns of one object.
 */
export const SPARKPLUG_LABELS: ProviderLabels = Object.freeze({
  entityName: "Edge node",
  entityNamePlural: "Edge nodes",
  rowName: "Metric value",
  rowNamePlural: "Metric values",
  selectAction: "Read",
  generateAction: "Draft a read",
  analyzeAction: "Not available",
  vacuumAction: "Not available",
  searchPlaceholder: "Filter metrics",
  analyzeGlobalLabel: "Not available",
  analyzeGlobalTitle: "A broker publishes no statistics to collect",
  analyzeGlobalDesc:
    "Sparkplug carries plant metrics over MQTT, and a broker keeps no catalog and no statistics a " +
    "client can read. What this connection knows is what one subscription delivered, plus the birth " +
    "certificates an aware broker had stored, and nothing more.",
  vacuumGlobalLabel: "Not available",
  vacuumGlobalTitle: "This connection writes nothing",
  vacuumGlobalDesc:
    "Maintenance would be a write, and on a Sparkplug system a write is an actuation: a command " +
    "writes device outputs, and a host state message makes the edge nodes waiting for that host " +
    "disconnect. This provider has no code that can write to a broker.",
  statementLanguage: "json",
});

/**
 * What the tree says instead of claiming a node is online.
 *
 * MEASURED on 2026-10-13 against Eclipse Mosquitto 2.1.2 and HiveMQ CE 2026.5, both with their
 * Sparkplug Aware plugins: a death does NOT remove the stored birth certificate, and a rebirth
 * replaces it. So the presence of a definition says nothing about whether the node is up, and
 * "online" is not a word this provider can honestly use.
 */
export const SPARKPLUG_NOT_SEEN =
  "Not seen in this read. An edge node that published nothing during the window and has a stored " +
  "birth certificate looks the same as one that is running and quiet, so this is not evidence that " +
  "it is gone.";

/** What the panel says for a value whose alias no birth certificate in hand defines. */
export const SPARKPLUG_UNRESOLVED_ALIAS =
  "This value arrived under an alias with no birth certificate to name it. A data message carries " +
  "the alias and not the name, so the name and the datatype come with the next birth.";

/** What the panel says beside a value taken from a stored birth certificate. */
export const SPARKPLUG_BIRTH_TIME_VALUE =
  "A birth-time value, from the copy the broker had stored. The specification says a stored " +
  "certificate's values cannot be expected to be the current ones.";

/**
 * What the panel says beside a value that came from a LIVE birth certificate rather than from a data
 * message in the window.
 *
 * Separate from the stored sentence on purpose: a stored certificate's values cannot be expected to
 * be current (10.1.4), while a live birth's values are the node's own current ones (4.1.1). Both are
 * birth-time values and only one of them is doubtful.
 */
export const SPARKPLUG_LIVE_BIRTH_VALUE =
  "The value the edge node published in its birth certificate, which 4.1.1 requires to be the " +
  "current one at that moment. No data message in this window carried a newer one.";
