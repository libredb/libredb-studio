/**
 * The pure half of a graph engine profile (spec 5.2).
 *
 * Pure, and shipped to the browser: the read policy and the editor read an engine only through these
 * shapes, so neither holds an engine's names of its own. Each engine supplies its lists; the server
 * half of a profile (port, catalog, error mapping) extends `GraphPolicyProfile` in
 * `graph-base-provider.ts`.
 */

/** What a read-only connection lets a user type, as lists `checkCypherRead` compares tokens against. */
export interface CypherReadPolicy {
  /** Uppercased word sequences refused wherever they appear as bare words, e.g. ["CREATE"], ["IN", "TRANSACTIONS"]. */
  readonly deniedWords: readonly (readonly string[])[];
  /** Lowercased name prefixes with their dot, e.g. "apoc.", refused as a procedure or a function. */
  readonly deniedNamespaces: readonly string[];
  /** Qualified procedure names `CALL` may name, compared exactly, as the engine spells them. */
  readonly allowedProcedures: readonly string[];
  /** Lowercased dotted built-in function names (SR7); an unqualified function is not checked. */
  readonly allowedQualifiedFunctions: readonly string[];
  /** Uppercased word sequences allowed after `SHOW`; "*" matches one name token of any kind. */
  readonly allowedShowForms: readonly (readonly string[])[];
  /** Statement prefixes refused outright. */
  readonly refusedPrefixes: readonly ("EXPLAIN" | "PROFILE")[];
}

/** The Cypher an engine accepts where engines differ. */
export interface GraphDialect {
  /**
   * A leading `CYPHER 5` or `CYPHER 25` is accepted. When false, `checkCypherRead` refuses the
   * prefix as `denied-prefix`, so a text the engine cannot parse never reaches it.
   */
  readonly supportsVersionPrefix: boolean;
  /**
   * The one offset keyword every measured engine accepts. The generators write SKIP unconditionally
   * and read no profile, so this literal records the fact and offers no choice; widen the type, and
   * make the generators read it, only when an engine needs another keyword.
   */
  readonly offsetKeyword: "SKIP";
}

/** The pure half of an engine profile: what the browser and the policy need. */
export interface GraphPolicyProfile {
  /** The engine's name in messages, e.g. "Neo4j". */
  readonly engineLabel: string;
  readonly readPolicy: CypherReadPolicy;
  readonly dialect: GraphDialect;
}
