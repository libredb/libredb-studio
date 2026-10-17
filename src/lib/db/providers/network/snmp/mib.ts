/**
 * The MIB modules this build carries, and the terms each one comes under.
 *
 * WHAT IS HERE AND WHAT IS NOT. Only modules published in an IETF RFC. No vendor module from
 * anybody: their terms differ from one another and most of them do not state a redistribution
 * grant at all, and loading a vendor's module is the user's business anyway. What this build
 * provides is the standard base.
 *
 * THE RULE THIS FILE FOLLOWS ABOUT ITS OWN CLAIMS. A module appears in `BUNDLED` only when the
 * document that publishes it is named and its terms are the ones that document carries. Where
 * that was not certain the module was dropped rather than described loosely, and the reason is
 * recorded beside it in `WITHHELD`. A shorter set is not a defect; a wrong statement about
 * somebody's licence is. Three modules the issue's own list named are withheld here for exactly
 * that reason, and dropping them costs something real, which `WITHHELD` says out loud.
 */

export interface MibModule {
  readonly name: string;
  /** The RFC that publishes it. Numbers only, no invented titles. */
  readonly rfc: number;
  /** Who the terms come from. Every entry below is the same answer, and that is the point. */
  readonly terms: "IETF Trust";
  readonly describes: string;
}

export interface WithheldModule {
  readonly name: string;
  /** Why it is not shipped. Never "maybe later": a reason that can be checked. */
  readonly reason: string;
  /** What is lost by leaving it out, stated rather than discovered later. */
  readonly cost: string;
}

/**
 * The shipped set. Each one is published in the RFC named, and the terms are that RFC's.
 */
export const BUNDLED: readonly MibModule[] = Object.freeze([
  { name: "SNMPv2-SMI", rfc: 2578, terms: "IETF Trust", describes: "the language the other modules are written in" },
  { name: "SNMPv2-TC", rfc: 2579, terms: "IETF Trust", describes: "the textual conventions values are rendered by" },
  { name: "SNMPv2-CONF", rfc: 2580, terms: "IETF Trust", describes: "the conformance statements the modules use" },
  { name: "SNMPv2-MIB", rfc: 3418, terms: "IETF Trust", describes: "the system group and the agent's own counters" },
  {
    name: "SNMP-FRAMEWORK-MIB",
    rfc: 3411,
    terms: "IETF Trust",
    describes: "the engine identity and its boots and time",
  },
  { name: "IF-MIB", rfc: 2863, terms: "IETF Trust", describes: "network interfaces, their counters and their state" },
  { name: "IP-MIB", rfc: 4293, terms: "IETF Trust", describes: "the IP layer's addresses and counters" },
  { name: "TCP-MIB", rfc: 4022, terms: "IETF Trust", describes: "TCP connections and their counters" },
  { name: "UDP-MIB", rfc: 4113, terms: "IETF Trust", describes: "UDP endpoints and their counters" },
  {
    name: "HOST-RESOURCES-MIB",
    rfc: 2790,
    terms: "IETF Trust",
    describes: "storage, processors, devices and running software",
  },
]);

/**
 * Named, with the reason and the cost, because an absence nobody explains reads as an oversight.
 */
export const WITHHELD: readonly WithheldModule[] = Object.freeze([
  {
    name: "IANAifType-MIB",
    reason:
      "IANA maintains it in a registry rather than publishing it in an RFC, so its terms are IANA's and not the " +
      "ones every other module here carries. Stating otherwise would be a claim about somebody's licence that " +
      "this file has not checked.",
    cost:
      "IF-MIB's ifType column is an IANAifType, so without this module that column reads as a bare integer " +
      "rather than as the interface type it names.",
  },
  {
    name: "IANA-ENTITY-MIB",
    reason: "The same: an IANA registry rather than an RFC.",
    cost: "ENTITY-MIB's physical class column loses its names, which is part of why ENTITY-MIB is withheld too.",
  },
  {
    name: "ENTITY-MIB",
    reason:
      "Its import closure reaches modules withheld above, and a module loaded without its imports is not loaded: " +
      "measured on 13 October 2026, loading it with its imports missing printed `Can not find` lines and then " +
      "threw on the first import from an unknown module.",
    cost: "Physical inventory, the entity table, is not listed. A later phase can add it with its closure intact.",
  },
]);

/** True when `name` is one of the modules this build actually carries. */
export function isBundled(name: string): boolean {
  return BUNDLED.some((entry) => entry.name === name);
}

/** The notice line for one module, built from the record rather than written by hand. */
export function noticeFor(entry: MibModule): string {
  return `${entry.name}: published in RFC ${entry.rfc}, ${entry.terms}.`;
}

/** Every notice, in the order the modules are declared, for the generated notices file. */
export function allNotices(): readonly string[] {
  return BUNDLED.map(noticeFor);
}

/**
 * Why a name this build cannot resolve is not resolved, said in the user's terms.
 *
 * A name from a withheld module gets its own sentence rather than "unknown object", because the
 * two are different: one is a name that does not exist and the other is a name this build chose
 * not to carry.
 */
export function explainUnknown(name: string): string {
  const withheld = WITHHELD.find((entry) => name.startsWith(entry.name) || name.includes(`${entry.name}::`));
  if (withheld !== undefined) {
    return `\`${name}\` is defined in ${withheld.name}, which this build does not carry. ${withheld.reason}`;
  }
  return (
    `\`${name}\` is not in any module this build carries. The bundled set is ${BUNDLED.map((m) => m.name).join(", ")}, ` +
    `and a numeric object identifier can be read without a module.`
  );
}
