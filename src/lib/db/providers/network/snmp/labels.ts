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
/**
 * What a statement on this engine is written in, for plan mode: the console's four commands. Its name alone would send
 * a model to Net-SNMP's tools (`snmpget -v2c ...`) or to a Set, and neither runs here.
 */
const SNMP_STATEMENT_LANGUAGE =
  "one SNMP console command this editor runs, written as the console writes it: get OID [OID ...] for named instances, next OID [OID ...] for the instance after each, walk SUBTREE for every instance under a subtree, or table ENTRY for a conceptual table's rows, named by its entry (table ifEntry), each OID written numerically (1.3.6.1.2.1.1.1.0) or by a name the bundled MIB modules define (sysDescr.0, ifDescr); there is no set and no Net-SNMP tool syntax, and the security and target modules under 1.3.6.1.6.3 (SNMP-TARGET-MIB, SNMP-NOTIFICATION-MIB, SNMP-PROXY-MIB, SNMP-USER-BASED-SM-MIB, SNMP-VIEW-BASED-ACM-MIB and SNMP-COMMUNITY-MIB), the transport security modules SNMP-SSH-TM-MIB (1.3.6.1.2.1.189), SNMP-TSM-MIB (1.3.6.1.2.1.190) and SNMP-TLS-TM-MIB (1.3.6.1.2.1.198), SNMP-USM-DH-OBJECTS-MIB (1.3.6.1.3.101) and Net-SNMP's NET-SNMP-VACM-MIB (1.3.6.1.4.1.8072.1.9) are never drafted, since agent mode withholds them; the inventory names the bundled MIB modules' tables and scalar groups with their declared columns, never a value the agent holds";

export const SNMP_LABELS: ProviderLabels = Object.freeze({
  statementLanguage: SNMP_STATEMENT_LANGUAGE,
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
 * Shown where a count of the agent's instances would otherwise be.
 *
 * Measured against Net-SNMP snmpd 5.9.4 on 13 October 2026: a read outside the agent's view is
 * indistinguishable from absence, returning noSuchObject per varbind on a Get and stepping over
 * to endOfMibView on a GetNext, with no authorizationError anywhere. So a zero here would be a
 * claim this provider has no evidence for.
 */
export const SNMP_NO_COUNT =
  "Instance counts are not read from the agent. The object tree counts the definitions in the MIB modules this " +
  "build carries, and a read the agent refuses looks exactly like one that found nothing, so no instance count " +
  "is shown rather than one that might be wrong.";
