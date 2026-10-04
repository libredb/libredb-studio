/**
 * The MySQL provider over the real mysql2 driver, against an in-process server.
 *
 * tests/integration/db/mysql-provider.test.ts replaces `mysql2/promise` with a mock, so mysql2's own
 * column decoding is never in its path. Here nothing is mocked: the real `MySQLProvider` builds a real
 * mysql2 pool, and the far side is mysql2's own `createServer()`, answering with column definitions
 * written byte for byte the way Databend, StarRocks and Apache Doris write them: collation 33
 * (utf8mb3_general_ci) on every text column, over plain UTF-8 bytes. The values then go through
 * mysql2's real text parser (`query`) and binary parser (`execute`).
 *
 * The server is also run as an honest MySQL, which labels a utf8mb4 session's text utf8mb4, to pin that
 * a connection the probe does not flag decodes exactly as mysql2 decides, and that mysql2's shared
 * `CharsetToEncoding` table is never written.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { AddressInfo } from "node:net";
import mysql2 from "mysql2";
import * as errors from "@/lib/db/errors";
import { DatabaseError } from "@/lib/db/errors";
import { MySQLProvider } from "@/lib/db/providers/sql/mysql";
import type { DatabaseConnection } from "@/lib/types";

const EMOJI = "\u{1F600}";
const TEXT = `Türkçe ğüşıöç İ ${EMOJI} 中文`;

const UTF8MB3_GENERAL_CI = 33;
const UTF8MB4_UNICODE_CI = 224;
const BINARY = 63;
const VAR_STRING = 253;
const BINARY_FLAG = 128;

/** mysql2's collation-id table as it ships, taken before any connection exists. */
const charsetToEncoding = (mysql2 as unknown as { CharsetToEncoding: string[] }).CharsetToEncoding;
const shipped = [...charsetToEncoding];

interface Column {
  name: string;
  characterSet: number;
  columnType: number;
  flags: number;
}

/** The part of mysql2's server-side connection these fakes drive. */
interface ServerConnection {
  sequenceId: number;
  serverHandshake(args: Record<string, unknown>): void;
  on(event: "query" | "stmt_prepare", listener: (sql: string) => void): void;
  on(event: "stmt_execute", listener: (statementId: number) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  writeTextResult(rows: Record<string, string>[], columns: Record<string, unknown>[], binary?: boolean): void;
  writeError(args: { message: string; code: number }): void;
  writeOk(args?: { affectedRows?: number; insertId?: number; serverStatus?: number }): void;
  writeEof(warnings?: number, statusFlags?: number): void;
  writeColumns(columns: Record<string, unknown>[]): void;
  writeTextRow(values: string[]): void;
  writePacket(packet: unknown): void;
}

interface FakeServer {
  listen(port: number, host: string, callback: () => void): void;
  on(event: "connection", listener: (connection: ServerConnection) => void): void;
  close(): void;
  _server: { address(): AddressInfo };
}

const definition = (column: Column) => ({
  catalog: "def",
  schema: "s",
  table: "t",
  orgTable: "t",
  name: column.name,
  orgName: column.name,
  characterSet: column.characterSet,
  columnLength: 400,
  columnType: column.columnType,
  flags: column.flags,
  decimals: 0,
});

/** A packet `writePacket` accepts, for the two the server side of mysql2 cannot write itself. */
const rawPacket = (payload: Buffer) => {
  const buffer = Buffer.concat([Buffer.alloc(4), payload]);
  return {
    buffer,
    length: () => payload.length,
    writeHeader(sequenceId: number) {
      buffer.writeUIntLE(payload.length, 0, 3);
      buffer[3] = sequenceId;
    },
  };
};

const lengthCoded = (text: string) => Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);

/** One parameter definition of a COM_STMT_PREPARE answer. */
const parameterPacket = () => {
  const tail = Buffer.alloc(13);
  tail.writeUInt8(0x0c, 0);
  tail.writeUInt16LE(BINARY, 1);
  tail.writeUInt8(VAR_STRING, 7);
  return rawPacket(
    Buffer.concat([
      lengthCoded("def"),
      lengthCoded(""),
      lengthCoded(""),
      lengthCoded(""),
      lengthCoded("?"),
      lengthCoded(""),
      tail,
    ]),
  );
};

/** COM_STMT_PREPARE OK: no columns announced, one parameter. */
const prepareOkPacket = (statementId: number) => {
  const payload = Buffer.alloc(12);
  payload.writeUInt32LE(statementId, 1);
  payload.writeUInt16LE(0, 5);
  payload.writeUInt16LE(1, 7);
  return rawPacket(payload);
};

/**
 * A server answering the provider's connect probes, a result set, OK packets and a multi-result answer.
 *
 * `textLabel` is what the server puts on every text column, the probe's included. 33 is what Databend,
 * StarRocks and Doris send in a utf8mb4 session; 224 is what MySQL sends there. The handshake announces
 * utf8mb4 (45), so mysql2's server side writes every value as UTF-8 whatever the column says.
 */
const startServer = (textLabel: number): Promise<{ port: number; close: () => void }> => {
  const server = (mysql2 as unknown as { createServer(): FakeServer }).createServer();
  let connectionId = 0;
  const result: Column[] = [
    { name: "v", characterSet: textLabel, columnType: VAR_STRING, flags: 0 },
    { name: "b", characterSet: BINARY, columnType: VAR_STRING, flags: BINARY_FLAG },
  ];
  const rows = [{ v: TEXT, b: "AB" }];
  const legacy = [definition({ name: "legacy", characterSet: UTF8MB3_GENERAL_CI, columnType: VAR_STRING, flags: 0 })];
  server.on("connection", (connection) => {
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: "8.0.90-fake",
      connectionId: ++connectionId,
      statusFlags: 2,
      characterSet: 45,
      capabilityFlags: 0xffffff,
    });
    // The client's QUIT at disconnect surfaces here as "Connection lost"; it is the end of a
    // conversation, not a failure.
    connection.on("error", () => {});
    // mysql2's server side never resets its packet counter between commands, so each answer
    // restarts it where a real server does, one past the client's command packet, and leaves
    // it at 0 for the next command.
    // SERVER_STATUS_AUTOCOMMIT (2), plus SERVER_STATUS_IN_TRANS (1) between BEGIN and
    // COMMIT, which is how a server that really opened a transaction answers.
    let inTransaction = false;
    const status = () => 2 | (inTransaction ? 1 : 0);
    const answer = (sql: string) => {
      if (sql.startsWith("SELECT '")) {
        connection.writeTextResult(
          [{ probe: EMOJI }],
          [definition({ name: "probe", characterSet: textLabel, columnType: VAR_STRING, flags: 0 })],
        );
      } else if (sql.includes("VERSION()")) {
        connection.writeTextResult(
          [{ version: "8.0.90" }],
          [definition({ name: "version", characterSet: textLabel, columnType: VAR_STRING, flags: 0 })],
        );
      } else if (sql.startsWith("SELECT v, b")) {
        connection.writeTextResult(rows, result.map(definition));
      } else if (sql.startsWith("SELECT legacy")) {
        connection.writeTextResult([{ legacy: TEXT }], legacy);
      } else if (/^(BEGIN|START TRANSACTION)/.test(sql)) {
        inTransaction = true;
        connection.writeOk({ serverStatus: status() });
      } else if (/^(COMMIT|ROLLBACK)/.test(sql)) {
        inTransaction = false;
        connection.writeOk({ serverStatus: status() });
      } else if (sql.startsWith("INSERT")) {
        connection.writeOk({ affectedRows: 2, insertId: 7, serverStatus: status() });
      } else if (/^(UPDATE|DELETE|CREATE)/.test(sql)) {
        connection.writeOk({ affectedRows: sql.startsWith("UPDATE") ? 1 : 0, serverStatus: status() });
      } else if (sql.startsWith("CALL")) {
        // Three results chained by SERVER_MORE_RESULTS_EXISTS (8): an OK packet, a result set,
        // and the closing OK packet a stored procedure's CALL always ends with.
        connection.writeOk({ affectedRows: 1, serverStatus: 2 | 8 });
        connection.writeColumns(legacy);
        connection.writeTextRow([TEXT]);
        connection.writeEof(0, 2 | 8);
        connection.writeOk({ affectedRows: 0, serverStatus: 2 });
      } else if (sql.startsWith("BROKEN")) {
        connection.writeError({ message: "You have an error in your SQL syntax", code: 1064 });
      } else {
        // The EXPLAIN grammar probes among them: refused, as Databend refuses them.
        connection.writeError({ message: `unsupported: ${sql}`, code: 1064 });
      }
    };
    connection.on("query", (sql) => {
      connection.sequenceId = 1;
      answer(sql);
      connection.sequenceId = 0;
    });
    const prepared = new Map<number, string>();
    connection.on("stmt_prepare", (sql) => {
      connection.sequenceId = 1;
      prepared.set(prepared.size + 1, sql);
      connection.writePacket(prepareOkPacket(prepared.size));
      connection.writePacket(parameterPacket());
      connection.writeEof();
      connection.sequenceId = 0;
    });
    connection.on("stmt_execute", (statementId) => {
      connection.sequenceId = 1;
      if (prepared.get(statementId)?.startsWith("INSERT")) {
        // A prepared statement answering zero columns.
        connection.writeOk({ affectedRows: 2, insertId: 7, serverStatus: status() });
      } else {
        connection.writeTextResult(rows, result.map(definition), true);
      }
      connection.sequenceId = 0;
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server._server.address().port, close: () => server.close() }));
  });
};

const config = (port: number): DatabaseConnection => ({
  id: `fake-${port}`,
  name: "fake",
  type: "mysql",
  host: "127.0.0.1",
  port,
  database: "d",
  user: "u",
  password: "",
  createdAt: new Date(0),
});

let labelling33: { port: number; close: () => void };
let honest: { port: number; close: () => void };
const providers: MySQLProvider[] = [];

const connected = async (port: number): Promise<MySQLProvider> => {
  const provider = new MySQLProvider(config(port));
  providers.push(provider);
  await provider.connect();
  return provider;
};

beforeAll(async () => {
  labelling33 = await startServer(UTF8MB3_GENERAL_CI);
  honest = await startServer(UTF8MB4_UNICODE_CI);
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.disconnect()));
  // Whatever a test did, the process-wide table is the one mysql2 ships.
  expect(charsetToEncoding).toEqual(shipped);
});

afterAll(() => {
  labelling33.close();
  honest.close();
});

describe("a server that labels UTF-8 text utf8mb3 (Databend, StarRocks, Doris)", () => {
  test("the shipped decoder for 33 is cesu8, which is the defect being worked around", () => {
    expect(shipped[UTF8MB3_GENERAL_CI]).toBe("cesu8");
  });

  test("a value outside the BMP reads as itself over the text protocol", async () => {
    const provider = await connected(labelling33.port);
    const result = await provider.query("SELECT v, b FROM t");
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.v).toBe(TEXT);
    expect(row.v).not.toContain("\uFFFD");
  });

  test("and over the prepared protocol", async () => {
    const provider = await connected(labelling33.port);
    const result = await provider.query("SELECT v, b FROM t WHERE v = ?", ["x"]);
    expect((result.rows[0] as Record<string, unknown>).v).toBe(TEXT);
  });

  test("a binary (63) column still arrives as bytes", async () => {
    const provider = await connected(labelling33.port);
    const text = await provider.query("SELECT v, b FROM t");
    const prepared = await provider.query("SELECT v, b FROM t", ["x"]);
    for (const result of [text, prepared]) {
      const value = (result.rows[0] as Record<string, unknown>).b;
      expect(Buffer.isBuffer(value)).toBe(true);
      expect((value as Buffer).toString("latin1")).toBe("AB");
    }
  });

  /**
   * The relabelled path runs over mysql2's callback API, so its error is the driver's own error
   * object as the promise wrapper would have rejected with: same class, message, `code`, `errno`
   * and `sqlState`. Only the stack differs, because the wrapper rewrites it to the caller's.
   */
  test("a statement the server refuses fails exactly as it does on mysql2's own path", async () => {
    const raw = spyOn(errors, "mapDatabaseError");
    const refusal = async (port: number) => {
      const provider = await connected(port);
      const mapped = await provider.query("BROKEN").catch((error: unknown) => error);
      return { mapped, driver: raw.mock.calls.at(-1)?.[0] as Record<string, unknown> };
    };
    const relabelled = await refusal(labelling33.port);
    const plain = await refusal(honest.port);
    raw.mockRestore();

    expect(relabelled.mapped).toBeInstanceOf(DatabaseError);
    expect((relabelled.mapped as Error).message).toBe("You have an error in your SQL syntax");
    expect(relabelled.mapped?.constructor).toBe(plain.mapped?.constructor);
    expect((relabelled.mapped as Error).message).toBe((plain.mapped as Error).message);
    for (const key of ["message", "code", "errno", "sqlState", "sqlMessage"]) {
      expect(relabelled.driver[key]).toBe(plain.driver[key]);
    }
    expect(relabelled.driver.errno).toBe(1064);
  });
});

describe("a server that labels utf8mb4 text honestly (MySQL, MariaDB, TiDB)", () => {
  test("the probe leaves the connection on mysql2's own decoding", async () => {
    const provider = await connected(honest.port);
    const result = await provider.query("SELECT v, b FROM t");
    expect((result.rows[0] as Record<string, unknown>).v).toBe(TEXT);
  });

  /**
   * The relabelling belongs to the pool that was measured, not to the process. With a flagged
   * provider connected beside it, a column the honest server labels 33 over 4-byte UTF-8 (which
   * MySQL itself never sends) reads exactly as mysql2 alone reads it, cesu8 and all.
   */
  test("a flagged pool beside it changes nothing on its connections", async () => {
    const flagged = await connected(labelling33.port);
    const provider = await connected(honest.port);

    const unflagged = (await provider.query("SELECT legacy FROM t")).rows[0] as Record<string, unknown>;
    expect(unflagged.legacy).toBe(TEXT.replace(EMOJI, "\uFFFD".repeat(4)));

    const relabelled = (await flagged.query("SELECT legacy FROM t")).rows[0] as Record<string, unknown>;
    expect(relabelled.legacy).toBe(TEXT);
  });
});

/**
 * Every statement that answers an OK packet instead of a result set. mysql2 emits `fields` with
 * nothing for each of those, and the relabelling listener has to let that through: a throw there is
 * fatal to the connection, after the server has already run the statement.
 */
describe("statements that answer no result set, on both kinds of server", () => {
  /** The driver's own answer, as `buildQueryResult` received it. */
  const driverAnswer = async (run: (provider: MySQLProvider) => Promise<unknown>, port: number, stub = false) => {
    const provider = await connected(port);
    const build = spyOn(
      MySQLProvider.prototype as unknown as { buildQueryResult: (rows: unknown) => unknown },
      "buildQueryResult",
    );
    // `buildQueryResult` reads one result set; a multi-result answer is read here at the driver
    // seam instead, which is the part this file is about.
    if (stub) build.mockImplementation(() => ({ rows: [], fields: [], rowCount: 0, executionTime: 0 }));
    try {
      const result = await run(provider);
      return { result, header: build.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>, provider };
    } finally {
      build.mockRestore();
    }
  };

  const headerOf = (answer: { header: Record<string, unknown> }) => {
    const { affectedRows, insertId } = answer.header;
    return { affectedRows, insertId };
  };

  test.each([
    ["INSERT over the text protocol", "INSERT INTO t VALUES (1)", undefined],
    ["INSERT over the prepared protocol", "INSERT INTO t VALUES (?)", ["x"]],
    ["UPDATE", "UPDATE t SET v = 'x'", undefined],
    ["DELETE", "DELETE FROM t", undefined],
    ["CREATE TABLE", "CREATE TABLE u (id INT)", undefined],
  ])("%s answers the same header and rowCount", async (_label, sql, params) => {
    const relabelled = await driverAnswer((provider) => provider.query(sql, params), labelling33.port);
    const plain = await driverAnswer((provider) => provider.query(sql, params), honest.port);

    expect(headerOf(relabelled)).toEqual(headerOf(plain));
    expect((relabelled.result as { rowCount: number }).rowCount).toBe((plain.result as { rowCount: number }).rowCount);
    // The connection survived: the next statement on the same pool still answers.
    const after = await relabelled.provider.query("SELECT v, b FROM t");
    expect((after.rows[0] as Record<string, unknown>).v).toBe(TEXT);
  });

  test("the INSERT header carries the server's counts", async () => {
    const relabelled = await driverAnswer((provider) => provider.query("INSERT INTO t VALUES (1)"), labelling33.port);
    expect(headerOf(relabelled)).toEqual({ affectedRows: 2, insertId: 7 });
    expect((relabelled.result as { rowCount: number }).rowCount).toBe(2);
  });

  test("a transaction keeps its connection through an INSERT and commits", async () => {
    const provider = await connected(labelling33.port);
    await provider.beginTransaction();
    const inserted = await provider.queryInTransaction("INSERT INTO t VALUES (1)");
    const read = await provider.queryInTransaction("SELECT v, b FROM t");
    await provider.commitTransaction();

    expect(inserted.rowCount).toBe(2);
    expect((read.rows[0] as Record<string, unknown>).v).toBe(TEXT);
    expect(provider.isInTransaction()).toBe(false);
  });

  /**
   * An OK packet, a result set and a closing OK packet in one answer. `fields` fires three times,
   * empty, with a utf8mb3 column, and empty again: the listener has to pass the empty ones and
   * relabel the other, and the connection has to survive all three.
   */
  test("a result set between two OK packets is still relabelled", async () => {
    const relabelled = await driverAnswer((provider) => provider.query("CALL two_results()"), labelling33.port, true);
    const plain = await driverAnswer((provider) => provider.query("CALL two_results()"), honest.port, true);

    type Answer = [Record<string, unknown>, Record<string, unknown>[], Record<string, unknown>];
    const [okRelabelled, rowsRelabelled, endRelabelled] = relabelled.header as unknown as Answer;
    const [okPlain, rowsPlain, endPlain] = plain.header as unknown as Answer;
    expect(okRelabelled.affectedRows).toBe(okPlain.affectedRows);
    expect(endRelabelled.affectedRows).toBe(endPlain.affectedRows);
    expect(rowsRelabelled[0]?.legacy).toBe(TEXT);
    expect(rowsPlain[0]?.legacy).toBe(TEXT.replace(EMOJI, "\uFFFD".repeat(4)));

    const after = await relabelled.provider.query("SELECT v, b FROM t");
    expect((after.rows[0] as Record<string, unknown>).v).toBe(TEXT);
  });
});
