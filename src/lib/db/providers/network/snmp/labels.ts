/**
 * The SNMP provider's labels.
 *
 * Pure, and answered before a connection opens, so every sentence here has to be true of an
 * agent in general rather than of the one a user happens to be pointed at.
 *
 * Every control this provider does not offer says WHY in the same breath, because a disabled
 * button with no reason reads as a defect in the product rather than as a fact about SNMP. The
 * reasons below are facts about the protocol and about this provider's own refusals, not
 * apologies: an agent keeps no catalog to analyse and nothing to reclaim, and this provider
 * sends three PDU types and has no code that can write.
 */
import type { ProviderLabels } from "@/lib/db/types";

/**
 * An agent holds managed objects. The thing a user opens is a conceptual table or a group of
 * scalars, and the thing inside it is an instance, which is what a row is here. "Object" alone
 * would be ambiguous: in SNMP it names the definition, not the value.
 */
export const SNMP_LABELS: ProviderLabels = Object.freeze({
  entityName: "Object group",
  entityNamePlural: "Object groups",
  rowName: "Instance",
  rowNamePlural: "Instances",
  selectAction: "Read",
  generateAction: "Not available",
  analyzeAction: "Not available",
  vacuumAction: "Not available",
  searchPlaceholder: "Filter objects",
  analyzeGlobalLabel: "Not available",
  analyzeGlobalTitle: "An agent publishes no statistics to collect",
  analyzeGlobalDesc:
    "There is no catalog behind an SNMP agent to gather statistics from. What a connection knows comes from " +
    "the MIB modules this build carries and from the instances a read returned, and nothing else.",
  vacuumGlobalLabel: "Not available",
  vacuumGlobalTitle: "This connection writes nothing",
  vacuumGlobalDesc:
    "Maintenance would be a write, and this provider has no code that can write to an agent: it sends " +
    "GetRequest, GetNextRequest and GetBulkRequest, and the seam its client sits behind reaches nothing else.",
});

/**
 * Shown where a count would otherwise be.
 *
 * Measured against Net-SNMP snmpd 5.9.4 on 13 October 2026: a read outside the agent's view is
 * indistinguishable from absence, returning noSuchObject per varbind on a Get and stepping over
 * to endOfMibView on a GetNext, with no authorizationError anywhere. So a zero here would be a
 * claim this provider has no evidence for.
 */
export const SNMP_NO_COUNT =
  "Counts are not read from the agent. The object tree comes from the MIB modules this build carries, and a " +
  "read the agent refuses looks exactly like one that found nothing, so no number is shown rather than a " +
  "number that might be wrong.";
