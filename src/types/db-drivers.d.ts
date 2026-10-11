/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "mssql" {
  const mssql: any;
  namespace mssql {
    type ConnectionPool = any;
    type Transaction = any;
    type Request = any;
    type config = any;
    type IResult = any;
  }
  export = mssql;
}

/**
 * `oracledb` ships NO type declarations of its own, and there is no `@types/oracledb`
 * in this project's dependency tree. Verified against the installed 6.10.0:
 * `node_modules/oracledb/package.json` has neither a `types` nor a `typings` field, and
 * `find node_modules/oracledb -name '*.d.ts'` matches nothing. So the driver's own types
 * cannot be imported, and this declaration is the only thing that can check the calls -
 * which is why it names the real surface instead of `any` (2026-08-24). Every member below is
 * one this repo actually uses, spelled as the installed driver behaves; nothing is
 * declared speculatively.
 */
declare module "oracledb" {
  const oracledb: {
    /** Column-type identities, compared by reference against `Metadata.dbType`. */
    readonly DB_TYPE_CLOB: oracledb.DbType;
    readonly DB_TYPE_NCLOB: oracledb.DbType;
    readonly DB_TYPE_BLOB: oracledb.DbType;
    readonly DB_TYPE_INTERVAL_YM: oracledb.DbType;
    readonly DB_TYPE_INTERVAL_DS: oracledb.DbType;
    readonly DB_TYPE_DATE: oracledb.DbType;
    readonly DB_TYPE_TIMESTAMP: oracledb.DbType;
    /** Fetch-target identities, the value side of a `fetchTypeHandler` answer. */
    readonly STRING: number;
    readonly BUFFER: number;
    readonly OUT_FORMAT_OBJECT: number;
    /** Process-wide defaults the provider sets once, in its constructor. */
    outFormat: number;
    autoCommit: number | boolean;
    fetchAsString: readonly oracledb.DbType[];
    initOracleClient(options: { libDir?: string }): void;
    createPool(attributes: oracledb.PoolAttributes): Promise<oracledb.Pool>;
  };

  namespace oracledb {
    /**
     * A driver type identity. Only `===` against the `DB_TYPE_*` constants is ever used,
     * so the two readable members are here for diagnostics and nothing branches on them.
     */
    interface DbType {
      readonly num: number;
      readonly name: string;
    }

    /**
     * One column of a result. `dbTypeName` is Oracle's own uppercase spelling
     * (`NUMBER`, `TIMESTAMP WITH TIME ZONE`) and reaches `QueryResult.columnTypes`
     * verbatim; `precision`/`scale` sit beside it and are deliberately unused
     * (see `oracleColumnTypes` in providers/sql/column-types.ts).
     */
    interface Metadata {
      name: string;
      dbType?: DbType;
      dbTypeName?: string;
      precision?: number;
      scale?: number;
    }

    /**
     * What a `fetchTypeHandler` may answer: a fetch target, a converter the driver puts each
     * fetched value through (NULL included, as `null`), or nothing to keep the default.
     */
    type FetchType = { type: number } | { converter: (value: unknown) => unknown } | undefined;

    type FetchTypeHandler = (metaData: Metadata) => FetchType;

    interface ExecuteOptions {
      outFormat?: number;
      autoCommit?: boolean;
      fetchTypeHandler?: FetchTypeHandler;
    }

    /**
     * One statement's answer. `rows` and `metaData` are ABSENT for a non-SELECT and
     * `rowsAffected` is absent for a SELECT - the optionality is the contract, not
     * defensiveness (see `buildQueryResult` in providers/sql/oracle.ts).
     */
    interface Result {
      rows?: unknown[];
      metaData?: Metadata[];
      rowsAffected?: number;
    }

    /** `INTERVAL YEAR TO MONTH` as the driver builds it. Both fields carry the sign. */
    interface IntervalYM {
      years: number;
      months: number;
    }

    /** `INTERVAL DAY TO SECOND` as the driver builds it; `fseconds` is nanoseconds. */
    interface IntervalDS {
      days: number;
      hours: number;
      minutes: number;
      seconds: number;
      fseconds: number;
    }

    interface Connection {
      execute(sql: string, binds?: unknown[], options?: ExecuteOptions): Promise<Result>;
      close(): Promise<void>;
      break(): Promise<void>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
    }

    interface Pool {
      getConnection(): Promise<Connection>;
      close(drainTime?: number): Promise<void>;
      readonly connectionsOpen: number;
      readonly connectionsInUse: number;
    }

    /**
     * Pool attributes. The index signature is deliberate: `buildTLSAttributes()` spreads
     * a computed set of TLS attribute names in, and the driver accepts many more than
     * this provider names.
     */
    interface PoolAttributes {
      user?: string;
      password?: string;
      connectString?: string;
      poolMin?: number;
      poolMax?: number;
      poolTimeout?: number;
      [attribute: string]: unknown;
    }
  }
  export = oracledb;
}

/**
 * `mqtt-packet`'s parser module, declared alone and on purpose.
 *
 * THE SPECIFIER IS THE GUARANTEE. The package root (`mqtt-packet`, whose `main` is `mqtt.js`) is three
 * lines: `exports.parser`, `exports.generate` and `exports.writeToStream`. Importing the root puts the
 * packet WRITER in the bundle, one call away from a PUBLISH. The subpath `mqtt-packet/parser.js` is
 * `module.exports = Parser`, a class carrying the factory as a static, and it reaches `bl`, `debug`,
 * `events`, `./packet` and `./constants` - never `./generate` or `./writeToStream`. Measured on the
 * installed 9.0.2: the root yields a working `generate` that produced the PUBLISH `30060003612f6278`,
 * and this subpath yields `undefined` for both writer exports under Node and under bun (2026-10-11).
 *
 * The package ships no declarations and there is no `@types/mqtt-packet`, so this file is the only
 * thing that can check the call. It names exactly the surface this repo uses and nothing more, which
 * is why a later `generate(...)` would not compile rather than quietly working.
 */
declare module "mqtt-packet/parser.js" {
  /** What a parser instance does: fed bytes, it emits `packet` and `error`. */
  interface MqttPacketParser {
    /** Feeds a chunk in; returns how many bytes of it the parser still holds. */
    parse(buffer: Buffer): number;
    on(event: string, handler: (value: unknown) => void): void;
  }
  /** `module.exports` is the `Parser` class; `parser()` is its static factory. */
  const Parser: {
    parser(options: { protocolVersion: number }): MqttPacketParser;
  };
  export = Parser;
}
