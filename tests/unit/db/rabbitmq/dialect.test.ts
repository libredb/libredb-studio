/**
 * The rabbitmq dialect's generators: the click writes "last" and Generate Read Request writes "first", each name
 * written by JSON.stringify alone, and neither ever throws.
 */
import { describe, expect, test } from "bun:test";
import {
  NON_SQL_DESTRUCTIVE_VOCABULARY,
  vocabularyDecidesAlone,
  vocabularySendsToModel,
} from "@/lib/db/destructive-commands";
import { rabbitmqSelectQuery, rabbitmqTableQuery } from "@/lib/db/providers/stream/rabbitmq/generators";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";
import { DIALECT_EDITORS } from "@/lib/editor/dialect-editors";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

describe("the generators", () => {
  test("the click reads the last chunk, Generate Read Request the first message, 50 rows each", () => {
    expect(rabbitmqTableQuery(["/", "orders"])).toBe('{"vhost": "/", "stream": "orders", "from": "last", "limit": 50}');
    expect(rabbitmqSelectQuery(["/", "orders"])).toBe(
      '{"vhost": "/", "stream": "orders", "from": "first", "limit": 50}',
    );
  });

  test("names that look like syntax round-trip through JSON.parse unchanged", () => {
    const vhost = 'a "quoted", \n vhost %2F';
    const stream = `rtl\u202eevil ${"\u00e9".repeat(127)}`;
    for (const text of [rabbitmqTableQuery([vhost, stream]), rabbitmqSelectQuery([vhost, stream])]) {
      const parsed = JSON.parse(text) as { vhost: string; stream: string; limit: number };
      expect(parsed.vhost).toBe(vhost);
      expect(parsed.stream).toBe(stream);
      expect(parsed.limit).toBe(50);
    }
  });

  test("a path of the wrong length writes empty names rather than throwing", () => {
    expect(rabbitmqTableQuery([])).toBe('{"vhost": "", "stream": "", "from": "last", "limit": 50}');
    expect(rabbitmqSelectQuery(["only"])).toBe('{"vhost": "only", "stream": "", "from": "first", "limit": 50}');
  });
});

describe("the rabbitmq dialect's records", () => {
  const RABBITMQ: ProviderCapabilities = new RabbitMQProvider(rabbitmqConnection()).getCapabilities();

  test("a rabbitmq connection opens rabbitmq tabs, which render in json with the shared JSON formatter", () => {
    expect(resolveTabType(RABBITMQ)).toBe("rabbitmq");
    expect(editorLanguageForTabType("rabbitmq")).toBe("json");
    expect(DIALECT_EDITORS.rabbitmq.monacoId).toBe("json");
    expect(DIALECT_EDITORS.rabbitmq.format).toBe(DIALECT_EDITORS.kafka.format);
    expect(DIALECT_EDITORS.rabbitmq.format?.('{"limit":1}')).toBe('{\n  "limit": 1\n}');
  });

  test("offers no profile, model, count statement or SQL export", () => {
    expect(QUERY_DIALECTS.rabbitmq).toEqual({
      tabType: "rabbitmq",
      offersColumnProfiling: false,
      offersCodeGeneration: false,
      offersCountQuery: false,
      offersSqlExport: false,
    });
  });

  test("a tree click and Generate Read Request reach the provider's generators through the registry", () => {
    expect(generateTableQuery(["billing", "audit"], RABBITMQ)).toBe(rabbitmqTableQuery(["billing", "audit"]));
    expect(generateSelectQuery(["billing", "audit"], [], RABBITMQ)).toBe(rabbitmqSelectQuery(["billing", "audit"]));
  });

  test("the safety dialog reads no destructive verb and posts nothing for an AI analysis", () => {
    expect(NON_SQL_DESTRUCTIVE_VOCABULARY.rabbitmq?.operations.size).toBe(0);
    expect(NON_SQL_DESTRUCTIVE_VOCABULARY.rabbitmq?.read('{"vhost": "/", "stream": "orders"}')).toEqual([]);
    expect(vocabularyDecidesAlone("rabbitmq")).toBe(true);
    expect(vocabularySendsToModel("rabbitmq")).toBe(false);
  });
});
