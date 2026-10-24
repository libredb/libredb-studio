/**
 * The two encoders of one search model (#1566 spec 5.3) and the only producer of GraphQL text (spec W5).
 *
 * `encodeRest` writes the REST search or aggregate body back, a near identity after phase 0's checks. `encodeGraphql`
 * writes one `Get` or `Aggregate` document for a server that serves no REST route for the request (spec 3.3), through
 * the builder below, never by concatenating text a user typed:
 *
 * - every identifier (class, property, vector, enum word) is checked against GraphQL's name rule and Weaviate's own
 *   word lists here, again, though phase 0 has checked it, so a programming error cannot open the document;
 * - every string is written by one function, JSON's escaping, which is GraphQL's for the characters JSON escapes,
 *   and a string that is not well-formed Unicode is refused, since GraphQL cannot carry a lone surrogate;
 * - every number is the literal the user typed, kept by the console's tagged JSON, so neither path rounds it.
 *
 * The document has exactly one root field, `Get` or `Aggregate`, and one class under it. Pure.
 */
import {
  isTaggedFloat,
  isTaggedInt,
  type TaggedJson,
  type TaggedObject,
  toJsonText,
} from "@/lib/db/console/tagged-json";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/types";
import type { WeaviateSearchOp } from "./client";
import type { WeaviateSearchModel } from "./request";
import { WEAVIATE_ENUMS } from "./routes";
import type { SelectionField, WeaviateCollectionFacts } from "./schema";

const PROVIDER: DatabaseType = "weaviate";
const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** What `returnMetadata` names in REST, as GraphQL's `_additional` spells it. */
export const GRAPHQL_METADATA: Readonly<Record<string, string>> = Object.freeze({
  distance: "distance",
  certainty: "certainty",
  score: "score",
  explainScore: "explainScore",
  creationTime: "creationTimeUnix",
  lastUpdateTime: "lastUpdateTimeUnix",
});

/** REST's fusion words as GraphQL's enum spells them. */
const GRAPHQL_FUSION: Readonly<Record<string, string>> = Object.freeze({
  ranked: "rankedFusion",
  relativeScore: "relativeScoreFusion",
});

function fail(message: string): never {
  throw new QueryError(message, PROVIDER);
}

/** A GraphQL name, checked. */
export function graphqlName(name: string): string {
  if (!NAME.test(name)) fail(`${JSON.stringify(name)} cannot be written as a GraphQL name, so nothing was sent.`);
  return name;
}

/** An enum word from a closed list, checked against it. */
function graphqlEnum(word: string, words: readonly string[]): string {
  if (!words.includes(word)) fail(`${JSON.stringify(word)} is not a word this encoder writes, so nothing was sent.`);
  return graphqlName(word);
}

/** A GraphQL string: JSON's escaping, refused when the text is not well-formed Unicode. */
export function graphqlString(text: string): string {
  if (!text.isWellFormed())
    fail("A text in the request is not well-formed Unicode, so it cannot be sent over GraphQL.");
  return JSON.stringify(text);
}

/** A number the user typed, as its literal; a GraphQL Int or Float accepts every JSON number literal. */
function graphqlNumber(value: TaggedJson): string {
  if (isTaggedInt(value)) return value.digits;
  if (isTaggedFloat(value)) return value.text;
  if (typeof value === "number" && Number.isFinite(value)) return toJsonText(value);
  return fail("A number in the request cannot be written as a GraphQL number, so nothing was sent.");
}

/** A scalar value of a where filter or an argument: a string, a boolean or a number. */
function graphqlScalar(value: TaggedJson): string {
  if (typeof value === "string") return graphqlString(value);
  if (typeof value === "boolean") return String(value);
  return graphqlNumber(value);
}

function list(values: readonly string[]): string {
  return `[${values.join(",")}]`;
}

/** An input object: `{key:value,...}`, each key a checked name, the values already written. */
function inputObject(entries: readonly (readonly [string, string])[]): string {
  return `{${entries.map(([key, value]) => `${graphqlName(key)}:${value}`).join(",")}}`;
}

/** A where filter, as GraphQL's `where` argument writes it: the same keys, the operator as an enum. */
export function graphqlWhere(filter: TaggedObject): string {
  const entries: (readonly [string, string])[] = [];
  for (const key of Object.keys(filter)) {
    const value = filter[key];
    if (value === null) continue;
    if (key === "operator") entries.push([key, graphqlEnum(value as string, WEAVIATE_ENUMS.operator)]);
    else if (key === "operands")
      entries.push([key, list((value as readonly TaggedJson[]).map((o) => graphqlWhere(o as TaggedObject)))]);
    else if (key === "path")
      entries.push([key, list((value as readonly TaggedJson[]).map((p) => graphqlString(p as string)))]);
    else if (key === "valueGeoRange") entries.push([key, geoRange(value as TaggedObject)]);
    // GraphQL has no value<Type>Array keys: a list goes under the scalar key, so valueTextArray is written valueText
    // (measured on 1.37.4, 1.38.22 and 1.40.2: "Unknown field" for valueTextArray, the REST count for valueText).
    else if (Array.isArray(value)) entries.push([key.replace(/Array$/, ""), list(value.map(graphqlScalar))]);
    else entries.push([key, graphqlScalar(value)]);
  }
  return inputObject(entries);
}

function geoRange(range: TaggedObject): string {
  const coordinates = range.geoCoordinates as TaggedObject;
  const distance = range.distance as TaggedObject;
  return inputObject([
    [
      "geoCoordinates",
      inputObject([
        ["latitude", graphqlNumber(coordinates.latitude)],
        ["longitude", graphqlNumber(coordinates.longitude)],
      ]),
    ],
    ["distance", inputObject([["max", graphqlNumber(distance.max)]])],
  ]);
}

function selection(fields: readonly SelectionField[]): string {
  return fields
    .map((field) =>
      field.fields === undefined ? graphqlName(field.name) : `${graphqlName(field.name)}{${selection(field.fields)}}`,
    )
    .join(" ");
}

/** The properties a read selects: the ones named, or every plain property, each with the sub-selection GraphQL needs. */
export function selectedProperties(
  model: WeaviateSearchModel,
  facts: WeaviateCollectionFacts,
): readonly SelectionField[] {
  const names = model.returnProperties ?? facts.plainProperties;
  return names.flatMap((name) => {
    const field = facts.selections.get(name);
    return field === undefined ? [] : [field];
  });
}

function targetVectors(model: WeaviateSearchModel): readonly (readonly [string, string])[] {
  return model.targetVector === null ? [] : [["targetVectors", list([graphqlString(model.targetVector)])]];
}

function proximity(model: WeaviateSearchModel): readonly (readonly [string, string])[] {
  return [
    ...(model.distance === null ? [] : [["distance", graphqlNumber(model.distance)] as const]),
    ...(model.certainty === null ? [] : [["certainty", graphqlNumber(model.certainty)] as const]),
  ];
}

/** The search argument of a Get: bm25, hybrid, nearVector or nearObject. */
/** A search's argument; an aggregate takes none and never reaches here (encodeGraphql writes it alone). */
function searchArgument(model: WeaviateSearchModel & { readonly op: WeaviateSearchOp }): readonly [string, string] {
  switch (model.op) {
    case "search_bm25":
      return [
        "bm25",
        inputObject([
          ["query", graphqlString(model.query as string)],
          ...(model.queryProperties === null
            ? []
            : [["properties", list(model.queryProperties.map(graphqlString))] as const]),
        ]),
      ];
    case "search_hybrid":
      return [
        "hybrid",
        inputObject([
          ["query", graphqlString(model.query as string)],
          ["alpha", "0"],
          ...(model.queryProperties === null
            ? []
            : [["properties", list(model.queryProperties.map(graphqlString))] as const]),
          ...(model.fusionType === null
            ? []
            : [["fusionType", graphqlEnum(GRAPHQL_FUSION[model.fusionType], Object.values(GRAPHQL_FUSION))] as const]),
          ...(model.maxVectorDistance === null
            ? []
            : [["maxVectorDistance", graphqlNumber(model.maxVectorDistance)] as const]),
          ...targetVectors(model),
        ]),
      ];
    case "search_near_vector":
      return [
        "nearVector",
        inputObject([
          ["vector", list((model.vector as readonly TaggedJson[]).map(graphqlNumber))],
          ...proximity(model),
          ...targetVectors(model),
        ]),
      ];
    case "search_near_object":
      return [
        "nearObject",
        inputObject([["id", graphqlString(model.id as string)], ...proximity(model), ...targetVectors(model)]),
      ];
  }
}

function commonArguments(model: WeaviateSearchModel): (readonly [string, string])[] {
  return [
    ...(model.tenant === null ? [] : [["tenant", graphqlString(model.tenant)] as const]),
    ...(model.where === null ? [] : [["where", graphqlWhere(model.where)] as const]),
  ];
}

function argumentsText(entries: readonly (readonly [string, string])[]): string {
  return entries.length === 0 ? "" : `(${entries.map(([key, value]) => `${graphqlName(key)}:${value}`).join(",")})`;
}

/** The one GraphQL document for a search or aggregate model, as a request body `{"query": "..."}`. */
export function encodeGraphql(model: WeaviateSearchModel, facts: WeaviateCollectionFacts): string {
  const className = graphqlName(model.collection);
  let document: string;
  if (model.op === "aggregate") {
    const args = [
      ...commonArguments(model),
      ...(model.groupBy === null ? [] : [["groupBy", list([graphqlString(model.groupBy)])] as const]),
      ...(model.limit === null ? [] : [["limit", graphqlNumber(model.limit)] as const]),
    ];
    const grouped = model.groupBy === null ? "" : " groupedBy{value path}";
    document = `{Aggregate{${className}${argumentsText(args)}{meta{count}${grouped}}}}`;
  } else {
    const args = [
      ...commonArguments(model),
      searchArgument(model as WeaviateSearchModel & { readonly op: WeaviateSearchOp }),
      ...(model.limit === null ? [] : [["limit", graphqlNumber(model.limit)] as const]),
      ...(model.offset === null ? [] : [["offset", graphqlNumber(model.offset)] as const]),
      ...(model.autoLimit === null ? [] : [["autocut", graphqlNumber(model.autoLimit)] as const]),
      ...(model.consistencyLevel === null
        ? []
        : [["consistencyLevel", graphqlEnum(model.consistencyLevel, WEAVIATE_ENUMS.consistencyLevel)] as const]),
    ];
    const additional = ["id", ...model.returnMetadata.map((word) => graphqlName(GRAPHQL_METADATA[word]))];
    const properties = selection(selectedProperties(model, facts));
    document = `{Get{${className}${argumentsText(args)}{${properties === "" ? "" : `${properties} `}_additional{${additional.join(" ")}}}}}`;
  }
  return JSON.stringify({ query: document });
}

/** The REST body for a search or aggregate: the body as phase 0 checked it, with the target vector phase 1 found. */
export function encodeRest(body: TaggedObject, model: WeaviateSearchModel): string {
  if (model.op === "aggregate" || model.targetVector === null || Object.hasOwn(body, "targetVector")) {
    return toJsonText(body);
  }
  const copy: Record<string, TaggedJson> = Object.create(null);
  for (const key of Object.keys(body)) copy[key] = body[key];
  copy.targetVector = model.targetVector;
  return toJsonText(copy);
}
