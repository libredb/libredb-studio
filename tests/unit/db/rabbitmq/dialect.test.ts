/**
 * The rabbitmq dialect's generators: the click writes "last" and Generate Read Request writes "first", each name
 * written by JSON.stringify alone, and neither ever throws.
 */
import { describe, expect, test } from "bun:test";
import { rabbitmqSelectQuery, rabbitmqTableQuery } from "@/lib/db/providers/stream/rabbitmq/generators";

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
