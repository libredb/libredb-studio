/**
 * What a Weaviate console request reads from the collection it names (#1566 spec 5.3). Types only, importing
 * nothing: the provider's schema reader (`weaviateCollectionFacts`) builds them from the server's class definition,
 * and phase 1 of `request.ts` reads them.
 */

/**
 * One field of a GraphQL selection: a name, and the fields it needs selected under it. GraphQL refuses an object,
 * a geo coordinate or a phone number with no sub-selection (measured on 1.37.4), so the selection is built from
 * the schema and the two paths answer the same properties.
 */
export interface SelectionField {
  readonly name: string;
  readonly fields?: readonly SelectionField[];
}

export interface WeaviateVector {
  /** "" for the unnamed vector. */
  readonly name: string;
  /** The vectorizer module's name, `none` where vectors are supplied by the writer. */
  readonly vectorizer: string;
  /** `hnsw`, `flat`, `dynamic`, `hfresh`, or what the server declares. */
  readonly indexType: string;
  /** `cosine`, `dot`, `l2-squared`, `hamming`, `manhattan`; null where the server declares none. */
  readonly distance: string | null;
  /** The compression the index declares enabled, or null. */
  readonly quantization: string | null;
}

/** What a console request reads from the collection it names (spec 5.3, W3, W6, W11). */
export interface WeaviateCollectionFacts {
  readonly name: string;
  readonly multiTenant: boolean;
  readonly autoTenantActivation: boolean;
  readonly vectors: readonly WeaviateVector[];
  /** Every top-level property's GraphQL selection, by name; a cross-reference has none. */
  readonly selections: ReadonlyMap<string, SelectionField>;
  /** The non-reference properties, in schema order: what REST answers when a request names no property. */
  readonly plainProperties: readonly string[];
  /** The properties typed `int` or `int[]`, whose GraphQL nulls outside int32 are marked (spec 5.2). */
  readonly intProperties: ReadonlySet<string>;
  /** The reference properties, which a request may not select in this version. */
  readonly referenceProperties: ReadonlySet<string>;
}
