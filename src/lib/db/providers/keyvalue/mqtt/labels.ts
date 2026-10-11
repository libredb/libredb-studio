/**
 * The MQTT provider's labels (`docs/providers/mqtt.md` section 9).
 *
 * Pure, and shipped to the browser: `getLabels()` answers before connect, through `POST /api/db/provider-meta`.
 * Every sentence that names what the panel cannot do says why in the same breath, because a disabled control
 * with no reason reads as a defect.
 */
import type { ProviderLabels } from "@/lib/db/types";

/** A broker has topics, and a topic is the row. There is no table and no schema to name. */
export const MQTT_LABELS: ProviderLabels = Object.freeze({
  entityName: "Topic",
  entityNamePlural: "Topics",
  rowName: "Message",
  rowNamePlural: "Messages",
  selectAction: "Read",
  generateAction: "Not available",
  analyzeAction: "Not available",
  vacuumAction: "Not available",
  searchPlaceholder: "Filter topics",
  analyzeGlobalLabel: "Not available",
  analyzeGlobalTitle: "MQTT publishes no statistics to collect",
  analyzeGlobalDesc:
    "A broker keeps no catalog and no statistics a client can read. What this connection knows is what a " +
    "subscription delivered, and nothing more.",
  vacuumGlobalLabel: "Not available",
  vacuumGlobalTitle: "This connection writes nothing",
  vacuumGlobalDesc:
    "Maintenance would be a write, and this provider has no code that can write to a broker: its encoder " +
    "produces CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT, and nothing else.",
});

/** The sentence the Objects tree shows instead of listing topics, which the Keys panel lists. */
export const MQTT_TOPICS_LISTED_ELSEWHERE =
  "Topics are listed in the Keys panel, which is the only surface that enumerates them.";
