/**
 * The RabbitMQ provider's composition: what it declares, which labels it answers, and that the factory builds it on
 * its production seams with no I/O.
 */
import { describe, expect, test } from "bun:test";
import { READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { AMQP_PORT_EMPTY_CAUTION } from "@/lib/db/providers/stream/rabbitmq/errors";
import {
  RABBITMQ_CONTAINER_LEVELS,
  RabbitMQProvider,
  type RabbitMQSeams,
} from "@/lib/db/providers/stream/rabbitmq/index";
import { RABBITMQ_LABELS } from "@/lib/db/providers/stream/rabbitmq/labels";
import { SYSTEM_CLOCK, systemDeadlineSignal } from "@/lib/db/providers/stream/rabbitmq/limits";
import { RABBITMQ_OBJECT_KINDS } from "@/lib/db/providers/stream/rabbitmq/objects";
import { RABBITMQ_RESULT_FIELDS, RABBITMQ_STREAM_COLUMNS } from "@/lib/db/providers/stream/rabbitmq/results";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

/** The seams a provider holds; private on the class, read here only to assert the factory's defaults. */
function seamsOf(provider: unknown): RabbitMQSeams {
  return Reflect.get(provider as object, "seams") as RabbitMQSeams;
}

describe("declarations", () => {
  const capabilities = new RabbitMQProvider(rabbitmqConnection()).getCapabilities();

  test("a JSON read request of the rabbitmq dialect, read-only whatever the flag says", () => {
    expect(capabilities).toMatchObject({
      queryLanguage: "json",
      queryDialect: "rabbitmq",
      enforcesReadOnly: true,
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsMaintenance: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      tablesAreDerivedGroupings: false,
      declaresForeignKeys: false,
      statementTerminator: "none",
      maintenanceOperations: [],
      schemaRefreshPattern: "(?!)",
      defaultPort: 15672,
    });
    expect(READ_ONLY_ENFORCED.rabbitmq).toBe(capabilities.enforcesReadOnly === true);
  });

  test("one container level, the virtual host, and three static kinds", () => {
    expect(capabilities.containerLevels).toBe(RABBITMQ_CONTAINER_LEVELS);
    expect(RABBITMQ_CONTAINER_LEVELS).toEqual([{ id: "schema", label: "Virtual host", labelPlural: "Virtual hosts" }]);
    expect(capabilities.objectKinds).toBe(RABBITMQ_OBJECT_KINDS);
    expect(RABBITMQ_OBJECT_KINDS.map((kind) => [kind.id, kind.role, kind.hasColumns === true])).toEqual([
      ["stream", "relation", true],
      ["queue", "config", false],
      ["exchange", "config", false],
    ]);
    for (const kind of RABBITMQ_OBJECT_KINDS) {
      expect(kind).toMatchObject({ hasSource: true, sourceLanguage: "json", countIsListing: true });
    }
  });

  test("plan mode walks the session-default virtual host only, and nothing more", () => {
    expect(capabilities.agentWalkScope).toEqual({ mode: "session-default" });
  });

  test("the schema refresh pattern matches no request", () => {
    const pattern = new RegExp(capabilities.schemaRefreshPattern ?? "", "i");
    expect(pattern.test('{"vhost": "/", "stream": "drop-table", "from": "last"}')).toBe(false);
  });

  test("getLabels answers a copy of the provider's labels", () => {
    const provider = new RabbitMQProvider(rabbitmqConnection());
    expect(provider.getLabels()).toEqual(RABBITMQ_LABELS);
    expect(provider.getLabels()).not.toBe(RABBITMQ_LABELS);
  });
});

describe("the read result's columns", () => {
  test("nine columns in order, typed and with nullability as a read returns them", () => {
    expect(RABBITMQ_STREAM_COLUMNS.map((column) => [column.name, column.type, column.nullable])).toEqual([
      ["offset", "string", false],
      ["timestamp", "timestamp", true],
      ["exchange", "string", false],
      ["routing_key", "string", false],
      ["headers", "json", false],
      ["properties", "json", false],
      ["payload", "json", false],
      ["payload_encoding", "string", false],
      ["payload_bytes", "integer", false],
    ]);
    expect(RABBITMQ_STREAM_COLUMNS.every((column) => column.isPrimary === false)).toBe(true);
    expect(RABBITMQ_RESULT_FIELDS).toEqual(RABBITMQ_STREAM_COLUMNS.map((column) => column.name));
    expect(Object.isFrozen(RABBITMQ_STREAM_COLUMNS)).toBe(true);
    expect(Object.isFrozen(RABBITMQ_RESULT_FIELDS)).toBe(true);
  });
});

describe("seams", () => {
  test("the factory builds the provider on the production seams, with no seam from the connection", async () => {
    const provider = await createDatabaseProvider(rabbitmqConnection());
    expect(provider).toBeInstanceOf(RabbitMQProvider);
    expect(provider.isConnected()).toBe(false);
    const seams = seamsOf(provider);
    expect(seams.clock).toBe(SYSTEM_CLOCK);
    expect(seams.deadlineSignal).toBe(systemDeadlineSignal);
  });

  test("a seam passed to the constructor replaces only that seam", () => {
    const clock = { now: () => 0, setTimer: () => () => {} };
    const seams = seamsOf(new RabbitMQProvider(rabbitmqConnection(), {}, { clock }));
    expect(seams.clock).toBe(clock);
    expect(seams.deadlineSignal).toBe(systemDeadlineSignal);
  });

  test("the factory keeps a read-only connection's mode, because the provider enforces it", async () => {
    const provider = await createDatabaseProvider(rabbitmqConnection({ readOnly: true }));
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
  });
});

describe("connectWarnings", () => {
  test("an empty or absent AMQP port is the one caution, worded as the user's choice; a set port is none", () => {
    for (const amqpPort of ["", undefined]) {
      expect(new RabbitMQProvider(rabbitmqConnection({ amqpPort })).connectWarnings()).toEqual([
        { message: AMQP_PORT_EMPTY_CAUTION },
      ]);
    }
    expect(new RabbitMQProvider(rabbitmqConnection({ amqpPort: "5672" })).connectWarnings()).toEqual([]);
  });

  test("it reads no I/O: a provider that never connected answers it", () => {
    const provider = new RabbitMQProvider(rabbitmqConnection({ amqpPort: "" }));
    expect(provider.isConnected()).toBe(false);
    expect(provider.connectWarnings()).toHaveLength(1);
  });
});
