/**
 * The migration DDL contract: what one engine's module tells the schema-diff migration generator
 * about the text it writes. Each statement kind has its own required function returning the whole
 * statement, and no flag is read by two statement kinds (spec 5.5).
 *
 * Every identifier arrives already quoted by the generator through `escapeIdentifier`, so no
 * module quotes one itself.
 */
import type { ColumnDiff } from "@/lib/schema-diff/types";

export type { ColumnDiff } from "@/lib/schema-diff/types";

/** Quoted parts of one foreign key: constraint `"fk_<table>_<column>"`, column, and references `"<table>"("<column>")`. */
export interface ForeignKeyDdl {
  readonly constraint: string;
  readonly column: string;
  readonly references: string;
}

/** Quoted parts of one index; qualifiedName is today's indexId (container path plus name). */
export interface IndexDdl {
  readonly name: string;
  readonly qualifiedName: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
}

/** Where a CREATE TABLE part goes: a line inside the parenthesized list, or a statement after it. */
export type InsideOrAfter = { readonly inside: string } | { readonly after: string };

export type CreateTableDdl =
  | { readonly kind: "refused"; readonly createTableRefusal: (table: string) => string }
  | {
      readonly kind: "written";
      readonly primaryKey: (columns: readonly string[]) => InsideOrAfter;
      readonly foreignKey: (fk: ForeignKeyDdl, table: string) => InsideOrAfter;
    };

export interface TableDdlRefused {
  readonly tableDdl: "refused";
  /** The one line after the header in place of any DDL ("-- <label>: Cannot generate table DDL. <reason>"). */
  readonly refusal: string;
  readonly transactionWrapper: null;
  readonly reasons: readonly string[];
}

export interface TableDdlWritten {
  readonly tableDdl: "written";
  readonly transactionWrapper: { readonly begin: string; readonly commit: string } | null;
  readonly createTable: CreateTableDdl;
  readonly columnDef: (col: ColumnDiff, column: string) => string;
  readonly createIndex: (index: IndexDdl, table: string) => string;
  readonly dropIndex: (index: IndexDdl, table: string) => string;
  readonly addForeignKey: (fk: ForeignKeyDdl, table: string) => string;
  readonly dropForeignKey: (constraint: string, table: string) => string;
  readonly addColumn: (definition: string, table: string) => string;
  readonly dropColumn: (col: ColumnDiff, column: string, table: string) => string;
  readonly modifyColumn: (col: ColumnDiff, column: string, table: string) => readonly string[];
  readonly dropTable: (table: string) => string;
  /** Every refusal sentence the module can print, verbatim (spec 5.5 "each refusal's reason"); [] when none. */
  readonly reasons: readonly string[];
}

export type MigrationDdlSpec = TableDdlRefused | TableDdlWritten;
