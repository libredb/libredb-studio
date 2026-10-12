/**
 * The Firestore rows and names the docs and listings carry beyond the provider doc: the providers README (its
 * Firestore and MQTT rows), ADDING_A_PROVIDER's id lists (the Firestore, BigQuery and MQTT ids), the API docs, the
 * seed docs, `.env.example`, the READMEs and Docker Hub. Counts and exhaustive lists are held by the existing guards.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const READMES = [
  "README.md",
  "README_zh.md",
  "README_ja.md",
  "README_es.md",
  "README_ur.md",
  "README_hi.md",
  "README_pt.md",
  "README_ru.md",
  "README_ko.md",
];

describe("docs/providers/README.md", () => {
  const index = read("docs/providers/README.md");

  test("carries the Firestore row, after Couchbase", () => {
    const lines = index.split("\n");
    const couchbase = lines.findIndex((line) => line.startsWith("| Couchbase | `couchbase` |"));
    expect(lines[couchbase + 1]).toBe(
      "| Google Cloud Firestore | `firestore` | Document | none, REST over the shared `node:https` transport (the Firestore REST API v1); `jose` signs service-account grants | The Admin SDK query chain (a read-only subset, parsed by Studio) | [firestore.md](./firestore.md) |",
    );
  });

  test("carries the MQTT row it lacked, after Kubernetes", () => {
    const lines = index.split("\n");
    const kubernetes = lines.findIndex((line) => line.startsWith("| Kubernetes | `kubernetes` |"));
    expect(lines[kubernetes + 1]).toBe(
      "| MQTT | `mqtt` | Key-Value (a broker's topic tree) | `mqtt-packet` (its parser only; the packets Studio sends are Studio's own) | None: no query console | [mqtt.md](./mqtt.md) |",
    );
  });

  test("names Firestore among the providers split across modules", () => {
    expect(index).toContain("S3, Kubernetes and Firestore are). The official product name");
  });
});

describe("docs/ADDING_A_PROVIDER.md", () => {
  const guide = read("docs/ADDING_A_PROVIDER.md");

  test("the DatabaseType example lines name bigquery, mqtt and firestore", () => {
    for (const line of guide.split("\n").filter((candidate) => candidate.startsWith("export type DatabaseType ="))) {
      for (const id of ["'bigquery'", "'mqtt'", "'firestore'"])
        expect({ line, id, named: line.includes(id) }).toEqual({ line, id, named: true });
    }
  });

  test("the providers index line names bigquery, mqtt and firestore", () => {
    const line = guide
      .split("\n")
      .find((candidate) => candidate.startsWith("**[docs/providers/](./providers/README.md)**"));
    expect(line).toContain("· bigquery ·");
    expect(line).toContain("· mqtt ·");
    expect(line).toContain("· firestore ·");
  });

  test("the driver-free ids count bigquery and firestore", () => {
    expect(guide).toContain("eighteen shipped ids do:");
    expect(guide).toContain("`databend`, `kubernetes`, `bigquery` and `firestore`");
  });

  test("the QueryTab example and the queryDialect row name every member of their unions", () => {
    expect(guide).toContain(
      "| 'influxql' | 'oxia' | 's3' | 'kubectl' | 'mqtt' | 'firestore';  // Add your type here if needed",
    );
    expect(guide).toContain("\\| 'oxia' \\| 's3' \\| 'mqtt' \\| 'firestore' \\| 'kubectl' \\| undefined`");
  });

  test("the no-driver answer names BigQuery and Firestore with their docs", () => {
    expect(guide).toContain("BigQuery over its REST API v2 ([bigquery.md](./providers/bigquery.md))");
    expect(guide).toContain("Firestore over its REST API v1 ([firestore.md](./providers/firestore.md))");
  });
});

describe("docs/API_DOCS.md", () => {
  const api = read("docs/API_DOCS.md");

  test("the Keys panel declaration and the console text bound name Firestore", () => {
    expect(api).toContain(
      'Firestore declares `{ "defaultCount": 100, "maxCount": 1000 }` and `"/"`, `"opaque"`, `"prefix"` and `"none"`, with `levels.rootKind` `"collection"`',
    );
    expect(api).toContain("S3-compatible object storage, Kubernetes and Firestore one of 65,536 bytes each");
  });

  test("the DatabaseType block and the connection fields name it", () => {
    expect(api).toMatch(/^type DatabaseType = .*'firestore'.*;$/m);
    expect(api).toContain("Firestore: the project id");
    expect(api).toContain("Firestore: the database id, empty for (default)");
  });
});

describe("docs/SEED_CONNECTIONS.md and .env.example", () => {
  test("a Firestore seed with an empty password for the server identity", () => {
    const seeds = read("docs/SEED_CONNECTIONS.md");
    expect(seeds).toContain('type: "firestore"');
    expect(seeds).toContain("Needs FIRESTORE_SERVER_CREDENTIALS=true on the server.");
  });

  test("both Firestore variables, and the Google variables worded for both opt-ins", () => {
    const env = read(".env.example");
    expect(env).toContain("# FIRESTORE_SERVER_CREDENTIALS=true");
    expect(env).toContain("# FIRESTORE_EMULATOR_HOST=127.0.0.1:8080");
    expect(env).toContain("# With either switch on (BIGQUERY_SERVER_CREDENTIALS or FIRESTORE_SERVER_CREDENTIALS):");
  });
});

describe("the READMEs and Docker Hub", () => {
  test.each(READMES)("%s has one Firestore engine row, and every full engine list names Firestore", (file) => {
    const lines = read(file).split("\n");
    expect(lines.filter((line) => line.startsWith("| **Firestore** |"))).toHaveLength(1);
    const lists = lines.filter(
      (line) => line.includes("Couchbase") && line.includes("Kubernetes") && line.includes("MQTT"),
    );
    for (const line of lists)
      expect({ file, line: line.slice(0, 80), named: line.includes("Firestore") }).toEqual({
        file,
        line: line.slice(0, 80),
        named: true,
      });
  });

  test("DOCKERHUB.md carries the Firestore row after Couchbase and names it read-only", () => {
    const hub = read("DOCKERHUB.md");
    const lines = hub.split("\n");
    const couchbase = lines.findIndex((line) => line.startsWith("| **Couchbase** |"));
    expect(lines[couchbase + 1]).toBe("| **Firestore** | none, REST | Read-only Admin SDK query chain |");
    expect(hub).toContain(
      "Firestore, Prometheus, InfluxDB, Apache Kafka, MQTT, Oxia, S3-compatible object storage and Kubernetes are read-only too",
    );
  });
});
