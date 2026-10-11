/**
 * `get -o json` and `get -o yaml`: one row per object, with its namespace, its name and the object as a document.
 *
 * The objects are read as JSON (the list walked with `continue`, or one read per name), redacted on the request
 * before anything is written, and written by Studio, so a Secret's document never holds its values or its
 * last-applied annotation and no document holds `managedFields`. A list item carries no `apiVersion` or `kind`, so
 * each document gets the resource's, as kubectl prints them. A statement shows at most 500 objects, and a list
 * holding more answers a sentence to narrow it; a document over 1 MiB is replaced by a sentence and a warning, and a
 * named read is capped at 2 MiB, past which its cell is that sentence too. The documents of one statement hold at
 * most 16 MiB together, past which the statement answers a sentence to narrow it and shows no partial grid.
 */
import { stringify } from "yaml";
import { QueryError } from "@/lib/db/errors";
import { ACCEPT_JSON } from "../client";
import type { IndexedResource } from "../discovery";
import { KubernetesRequestError, KubernetesResponseTooLargeError } from "../errors";
import {
  KUBERNETES_MAX_DOCUMENT_BYTES,
  KUBERNETES_MAX_DOCUMENT_OBJECTS,
  KUBERNETES_MAX_DOCUMENTS_BYTES,
  KUBERNETES_PAGE_SIZE,
  KUBERNETES_TYPE,
} from "../limits";
import { redactResponse } from "../redaction";
import { type KubeTable, parseTable, scanTable } from "../table";
import { inTurn, type KubectlContext, type KubectlGrid, namespaceFor, objectOf, resolveType } from "./context";
import { callOf, type GetStatement } from "./get-list";

const TOO_MANY = `The list holds more than ${KUBERNETES_MAX_DOCUMENT_OBJECTS} objects, the most -o json and -o yaml show: narrow it with -l, --field-selector or -n, or read it as a table without -o.`;

const BUDGET_SENTENCE =
  "The documents of this statement pass 16 MiB together, the most one -o json or -o yaml statement shows: narrow it with -l, --field-selector or fewer names, or read it as a table without -o.";

const oversized = (format: string): string =>
  `This document is larger than 1 MiB, the most one cell holds, so it is not shown; read the object with kubectl describe, or narrow -o ${format} to fewer objects.`;

/** The document of one object, with the resource's apiVersion and kind first when the object carries none. */
function documentText(
  object: Readonly<Record<string, unknown>>,
  resource: IndexedResource,
  format: "json" | "yaml",
): string {
  const apiVersion = resource.group === "" ? resource.version : `${resource.group}/${resource.version}`;
  const whole = { apiVersion, kind: resource.kind, ...object };
  return format === "json"
    ? JSON.stringify(whole, null, 2)
    : stringify(whole, { aliasDuplicateObjects: false, lineWidth: 0 });
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The objects of the list form, at most 500: a list holding more answers the sentence. */
async function listedObjects(
  context: KubectlContext,
  statement: GetStatement,
  resource: IndexedResource,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const namespace = namespaceFor(context, resource, statement);
  const read = async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await context.surface.client.json(
      {
        op: "list",
        target: resource,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          limit: page.limit,
          ...(statement.labelSelector === undefined ? {} : { labelSelector: statement.labelSelector }),
          ...(statement.fieldSelector === undefined ? {} : { fieldSelector: statement.fieldSelector }),
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...callOf(context, statement), accept: ACCEPT_JSON },
    );
    // A plain list reads as a two-column Table whose rows carry each item as their object.
    return parseTable(redactResponse(resource, body));
  };
  const scan = await scanTable(read, {
    offset: 0,
    limit: KUBERNETES_MAX_DOCUMENT_OBJECTS + 1,
    pageSize: KUBERNETES_PAGE_SIZE,
    halveOnTooLarge: true,
  });
  if (scan.rows.length > KUBERNETES_MAX_DOCUMENT_OBJECTS) throw new QueryError(TOO_MANY, KUBERNETES_TYPE);
  return scan.rows.map((row) => row.object ?? {});
}

type DocumentRow = { readonly NAMESPACE: unknown; readonly NAME: unknown; readonly DOCUMENT: string };

/** The rows of one statement, each cell counted against the statement's bytes as it is written. */
class DocumentRows {
  readonly rows: DocumentRow[] = [];
  replaced = 0;
  private bytes = 0;

  constructor(
    private readonly resource: IndexedResource,
    private readonly format: "json" | "yaml",
  ) {}

  /** One object's row: its document, or the oversized sentence when the document passes 1 MiB. */
  object(object: Readonly<Record<string, unknown>>): void {
    const metadata = objectOf(object.metadata) ?? {};
    const text = documentText(object, this.resource, this.format);
    const length = utf8Length(text);
    if (length > KUBERNETES_MAX_DOCUMENT_BYTES) this.oversized(metadata.namespace ?? null, metadata.name ?? null);
    else this.push({ NAMESPACE: metadata.namespace ?? null, NAME: metadata.name ?? null, DOCUMENT: text }, length);
  }

  oversized(namespace: unknown, name: unknown): void {
    const text = oversized(this.format);
    this.replaced += 1;
    this.push({ NAMESPACE: namespace, NAME: name, DOCUMENT: text }, utf8Length(text));
  }

  private push(row: DocumentRow, length: number): void {
    this.bytes += length;
    if (this.bytes > KUBERNETES_MAX_DOCUMENTS_BYTES) throw new QueryError(BUDGET_SENTENCE, KUBERNETES_TYPE);
    this.rows.push(row);
  }
}

/**
 * The rows of the named form, one read each, each written as it is read so the statement's bytes stop the reads; a
 * missing one is skipped with --ignore-not-found, and one past 2 MiB is the oversized cell.
 */
async function namedRows(
  context: KubectlContext,
  statement: GetStatement,
  resource: IndexedResource,
  rows: DocumentRows,
): Promise<void> {
  const namespace = namespaceFor(context, resource, statement);
  await inTurn(statement.names, async (name) => {
    let body: unknown;
    try {
      body = await context.surface.client.json(
        { op: "get", target: resource, ...(namespace === undefined ? {} : { namespace }), name },
        // Twice the cell's bytes: the answer's JSON is compact, and the document is written indented.
        { ...callOf(context, statement), accept: ACCEPT_JSON, maxResponseBytes: 2 * KUBERNETES_MAX_DOCUMENT_BYTES },
      );
    } catch (error) {
      if (error instanceof KubernetesResponseTooLargeError) return rows.oversized(namespace ?? null, name);
      if (
        statement.ignoreNotFound &&
        error instanceof KubernetesRequestError &&
        error.status === 404 &&
        !error.typeMissing
      )
        return;
      throw error;
    }
    rows.object(objectOf(redactResponse(resource, body)) ?? {});
  });
}

/** `-o json` or `-o yaml`: one row per object, a document cell each. */
export async function getDocuments(context: KubectlContext, statement: GetStatement): Promise<KubectlGrid> {
  const format = statement.output === "json" ? "json" : "yaml";
  const resource = await resolveType(context, statement.type);
  const rows = new DocumentRows(resource, format);
  if (statement.names.length === 0) {
    for (const object of await listedObjects(context, statement, resource)) rows.object(object);
  } else await namedRows(context, statement, resource, rows);
  const { replaced } = rows;
  return {
    fields: ["NAMESPACE", "NAME", "DOCUMENT"],
    rows: rows.rows,
    columnTypes: { NAMESPACE: "string", NAME: "string", DOCUMENT: "string" },
    ...(replaced === 0
      ? {}
      : {
          warnings: [
            {
              message: `${replaced} ${replaced === 1 ? "document is" : "documents are"} larger than 1 MiB and not shown; each such cell says so.`,
            },
          ],
        }),
  };
}
