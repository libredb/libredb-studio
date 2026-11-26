/**
 * What the repository's documents say about S3 where they list or count the engines: the README and its translations,
 * DOCKERHUB, the chart, FEATURES, BRAND_MESSAGING, CLAUDE.md, the agent documents, THIRD_PARTY_LICENSES and the
 * providers index, each held to the code's engine lists and counts.
 */
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { engineServerDialect } from "@/lib/agent/languages/engines/server";
import {
  connectableProductCount,
  EXTERNAL_DATABASE_TYPES,
  SHIPPED_DATABASE_TYPES,
  WIRE_COMPATIBLE_ENGINES,
} from "@/lib/db/compatibility";
import { LINK_LOCAL_NETWORKS } from "@/lib/db/http/egress-policy";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { readsSqlText } from "@/lib/sql/grammar";
import { type DatabaseConnection } from "@/lib/types";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ").replace(/\\([<>])/g, "$1");
/** An unsigned connection to a loopback endpoint: every builder check passes, so an override isolates one rule. */
const CONNECTION = {
  id: "s3-doc",
  name: "S3 test",
  type: "s3",
  host: "localhost",
  port: 9000,
  user: "",
  password: "",
} as DatabaseConnection;
const UNITS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** An English numeral as the copy spells it, for 1 to 99: `twenty-eight`, `fifty-five`. */
function word(count: number): string {
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error(`no numeral for ${count}`);
  if (count < 20) return UNITS[count];
  const unit = count % 10;
  return unit === 0 ? TENS[Math.floor(count / 10)] : `${TENS[Math.floor(count / 10)]}-${UNITS[unit]}`;
}
/**
 * The ordinal of a count, in words.
 *
 * Written out rather than patched onto `word` with suffix rules, because English ordinals are not a suffix
 * rule: the chain this replaced turned twenty-nine into twenty-ninth and thirty into thirtieth correctly, and
 * left thirty-one as "thirty-one", which is how a page published to Docker Hub came to read "The thirty-one
 * row is the embedded LibreDB store".
 */
function ordinal(count: number): string {
  const IRREGULAR: Readonly<Record<string, string>> = {
    one: "first",
    two: "second",
    three: "third",
    five: "fifth",
    eight: "eighth",
    nine: "ninth",
    twelve: "twelfth",
  };
  const spelled = word(count);
  const whole = (part: string): string =>
    part.endsWith("y") ? `${part.slice(0, -1)}ieth` : (IRREGULAR[part] ?? `${part}th`);
  if (!spelled.includes("-")) return whole(spelled);
  const [tens, unit] = spelled.split("-") as [string, string];
  return `${tens}-${whole(unit)}`;
}
/** The same numeral at the start of a sentence. */
const Word = (count: number): string => `${word(count).charAt(0).toUpperCase()}${word(count).slice(1)}`;
/** The provider every declaration case reads; it has no transport, so a call that would send fails loudly. */
const provider = new S3Provider(
  CONNECTION,
  {},
  { egress: ALLOWS_PRIVATE_HOSTS },
  {
    createTransport: () => {
      throw new Error("this test never connects");
    },
  },
);
/** How a prose list names each entry of LINK_LOCAL_NETWORKS: a /128 as the address, the NAT64 range by name. */
function networkWords(): string[] {
  return LINK_LOCAL_NETWORKS.map(([network, prefix]) =>
    prefix === 128 ? network : network.startsWith("64:ff9b:") ? "NAT64" : `${network}/${prefix}`,
  );
}
const AGENT_DOC = read("docs/AGENT.md");
/** The part of `database-compose.yml` the fixture tables are held to. */
interface ComposeService {
  readonly ports?: readonly string[];
  readonly profiles?: readonly string[];
  readonly restart?: string;
}
const COMPOSE = parseYaml(read("database-compose.yml"), { merge: true }) as {
  readonly services: Readonly<Record<string, ComposeService>>;
};
/** The host port compose publishes for `service`, from `127.0.0.1:<host>:<container>`. */
function hostPort(service: string): string {
  const published = COMPOSE.services[service]?.ports?.[0];
  if (published === undefined) throw new Error(`database-compose.yml publishes no port for ${service}`);
  const parts = published.split(":");
  if (parts.length !== 3) throw new Error(`${service} publishes ${published}, not 127.0.0.1:<host>:<container>`);
  return parts[1];
}
/** The six S3 fixture targets, by the name the fixture tables give each. */
const S3_FIXTURES: ReadonlyArray<{ readonly name: string; readonly service: string }> = [
  { name: "MinIO", service: "minio" },
  { name: "MinIO with a site region", service: "minio-region" },
  { name: "Silo", service: "silo" },
  { name: "Silo over TLS", service: "silo-tls" },
  { name: "Garage", service: "garage" },
  { name: "RustFS", service: "rustfs" },
];
/** A README fixture row's first cell: the bold engine name, the target, and its compose profile when it has one. */
function fixtureCell(fixture: (typeof S3_FIXTURES)[number]): string {
  const profile = COMPOSE.services[fixture.service]?.profiles?.[0];
  return `**S3-compatible object storage**, ${fixture.name}${profile === undefined ? "" : ` (profile \`${profile}\`)`}`;
}
/** The README line inserted above Databend's, exactly. */
const README_S3_LINE =
  "S3-compatible object storage came before Kubernetes: AWS CLI read commands typed in the editor, such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, and Studio's own `preview` read buckets and objects over the S3 REST API with no SDK, signed by Studio's own code with only the keys typed into the connection; the tree shows buckets, the Keys panel walks folders one level at a time, and an object opens with its metadata and a capped preview of text, JSON, CSV or Parquet, read-only by construction, because Studio sends only GET and HEAD requests; it is verified on MinIO, Silo, Garage and RustFS, and not on AWS S3 or any hosted service.";
/** The README engine-table row, exactly. */
const README_S3_ROW =
  "| **S3-compatible object storage** | none, HTTP (the S3 REST API, path style, signed by Studio's own SigV4 code; `hyparquet` for Parquet previews) | Read-only AWS CLI read commands such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, plus Studio's own `preview`; buckets in the tree and folders in the Keys panel, one level at a time; an object's metadata and a capped preview of text, JSON, NDJSON, CSV, TSV and Parquet, hex for anything else. Only the keys typed into the connection sign, never the server's own AWS identity, and the link-local networks, where AWS, Azure and Google Cloud serve instance metadata, are always refused, as is AWS's IPv6 metadata address. Verified on MinIO, Silo, Garage and RustFS; AWS S3 and hosted services are not verified |";
/** The FEATURES group, exactly. */
const FEATURES_GROUP = [
  "*   **Object Storage:**",
  "    *   **S3-compatible object storage:** Read-only over the S3 REST API with **no SDK and no driver**: Studio's own SigV4 code signs each request with the access key pair typed into the connection, never with the server's environment, shared credential files or instance role, and an empty pair sends unsigned requests.",
  "        AWS CLI read commands in the editor, such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, plus Studio's own `preview`; buckets in the tree, or the one bucket the connection names; folders and objects in the Keys panel, one folder level at a time with a Load more per level.",
  "        An object opens with its metadata and a capped preview of text, JSON, NDJSON, CSV, TSV and Parquet (through `hyparquet`, with Snappy, gzip, zstd, brotli and LZ4 pages), and a hex dump for anything else.",
  "        Path-style addressing only, a Region field that defaults to `us-east-1`, and link-local addresses (169.254.0.0/16 and fe80::/10) and AWS's IPv6 metadata address refused whatever the egress setting.",
  "        Verified on MinIO, Silo, Garage and RustFS ([providers/s3.md](./providers/s3.md)); AWS S3 and hosted services are not verified.",
].join("\n");
/** BRAND_MESSAGING rule 9, exactly. */
const BRAND_RULE_9 =
  '9. **Studio\'s S3 provider is read-only object browsing on S3-compatible servers, verified on four of them.** Write "S3-compatible object storage", never "S3" alone as a supported product, and never "AWS S3" or "Amazon S3" as one, because Studio was verified on MinIO, Silo, Garage and RustFS and not on AWS S3 or any hosted service. Never write that Studio queries files in a bucket with SQL; it previews them.';
/** The providers index row, exactly. */
const PROVIDERS_INDEX_ROW =
  "| S3-compatible object storage | `s3` | Object storage | none, REST over the shared `node:http(s)` transport, signed by Studio's own SigV4 code; `hyparquet` for Parquet previews | AWS CLI read commands (a subset, read-only) | [s3.md](./s3.md) |";
/** The installed manifest of `name`: hoisted, or nested under hyparquet-compressors. */
function installed(name: string): { readonly version: string; readonly license: string } {
  for (const at of [
    `node_modules/${name}/package.json`,
    `node_modules/hyparquet-compressors/node_modules/${name}/package.json`,
  ]) {
    if (existsSync(path.join(ROOT, at))) return JSON.parse(read(at)) as { version: string; license: string };
  }
  throw new Error(`${name} is not installed`);
}

describe("the repository's documents name S3 and count the engines", () => {
  test("AGENT.md cites B104 with its reason, after B103", () => {
    const b103 = AGENT_DOC.indexOf("- **B103**:");
    const b104 = AGENT_DOC.indexOf("- **B104**:");
    expect(b103).toBeGreaterThan(-1);
    expect(b104).toBeGreaterThan(b103);
    expect(AGENT_DOC).toContain(
      "- **B104**: S3's `s3api` statement language reads metadata only, through six GET and HEAD reads alone, so no object key the request did not name, body, user metadata, tag, ETag, version id, owner, ACL, policy or endpoint reaches an agent or MCP `run_s3_read` answer, a bucket is counted whole and never by prefix, MCP reads it only under the seed's agent read key, and data analysis, query optimization and database assessment are not offered, until a ruling of its own decides which object keys and values may be read (`docs/providers/s3.md` sections 3.6, 15 and 15.7).",
    );
  });

  test("every exhaustive engine list in the packaging and listing descriptions names S3", () => {
    for (const file of [
      "snap/snapcraft.yaml",
      "deploy/railway/TEMPLATE_OVERVIEW.md",
      "deploy/koyeb/CATALOG_SUBMISSION.md",
      "packaging/flatpak/org.libredb.Studio.metainfo.xml",
      "packaging/flatpark/org.libredb.Studio.metainfo.xml",
    ]) {
      expect(read(file), file).toContain("S3-compatible object storage");
    }
    for (const file of [
      "desktop/src-tauri/desktop-entry.hbs",
      "packaging/flatpak/org.libredb.Studio.desktop",
      "packaging/flatpark/org.libredb.Studio.desktop",
    ]) {
      expect(read(file), file).toContain(";Qdrant;Weaviate;Oxia;S3;ObjectStorage;MinIO;Kubernetes;IDE;");
    }
  });

  test("the numerals no gate reads count the external engines", () => {
    const engines = word(EXTERNAL_DATABASE_TYPES.length);
    expect(read("deploy/railway/TEMPLATE_OVERVIEW.md")).toContain(`any of the ${engines} engines above`);
    expect(read("packaging/aur/README.md")).toContain(`The files here name ${engines} engines`);
    expect(read("packaging/aur/.SRCINFO")).toContain(`for ${engines} database engines`);
  });

  const readme = read("README.md");
  const engines = EXTERNAL_DATABASE_TYPES.length;
  test("each README numeral counts its own denominator", () => {
    expect(readme).toContain(`${Word(engines)} engines share one interface:`);
    expect(readme).toContain(`Three of the ${word(engines)} have no write in their own SQL`);
    expect(readme).toContain(`- **${Word(engines)} engines, one interface**:`);
    expect(readme).toContain(`> **${Word(WIRE_COMPATIBLE_ENGINES.length)} more engines have no driver of their own.**`);
    expect(readme).toContain(`The ${word(engines)} above are the drivers this build ships.`);
    expect(readme).toContain(
      `so ${word(engines)} drivers reach ${word(connectableProductCount())} named engines in all.`,
    );
  });

  test("the S3 line and row are word for word, and the row's networks are LINK_LOCAL_NETWORKS", () => {
    expect(readme).toContain(`${README_S3_LINE}\nDatabend came before S3-compatible object storage:`);
    const lines = readme.split("\n");
    const oxia = lines.findIndex((line) => line.startsWith("| **Oxia** | `@grpc/grpc-js`"));
    expect(lines[oxia + 1]).toBe(README_S3_ROW);
    // The row names the networks in words: "the link-local networks" are 169.254.0.0/16 with its NAT64 form and
    // fe80::/10, and "AWS's IPv6 metadata address" is fd00:ec2::254. A network added to LINK_LOCAL_NETWORKS fails
    // here until the row's words are re-read against it.
    expect([...networkWords()].sort()).toEqual(["169.254.0.0/16", "NAT64", "fd00:ec2::254", "fe80::/10"].sort());
  });

  test("every S3 fixture row names the port compose publishes", () => {
    for (const file of ["README.md", "README_zh.md"]) {
      const lines = read(file).split("\n");
      for (const fixture of S3_FIXTURES) {
        const row = lines.find((line) => line.startsWith(`| ${fixtureCell(fixture)} |`));
        expect(row, `${file} ${fixture.service}`).toBeDefined();
        expect(row?.split(" | ")[2], `${file} ${fixture.service}`).toBe(hostPort(fixture.service));
      }
    }
  });

  test("every translation carries the S3 row under the same bold name", () => {
    for (const file of [
      "README_zh.md",
      "README_ja.md",
      "README_es.md",
      "README_ur.md",
      "README_hi.md",
      "README_pt.md",
      "README_ru.md",
      "README_ko.md",
    ]) {
      const rows = read(file)
        .split("\n")
        .filter((line) => line.startsWith("| **S3-compatible object storage** |"));
      expect(rows, file).toHaveLength(1);
    }
  });

  test("the S3 row, the numerals and the read-only sentence", () => {
    const hub = read("DOCKERHUB.md");
    const lines = hub.split("\n");
    const oxia = lines.findIndex((line) => line.startsWith("| **Oxia** |"));
    expect(lines[oxia + 1]).toBe(
      "| **S3-compatible object storage** | none, HTTP | Read-only AWS CLI commands, bucket and folder browser, object preview |",
    );
    expect(hub).toContain("Qdrant, Weaviate, Oxia, S3-compatible object storage and Kubernetes** from your browser");
    expect(hub).toContain(`${Word(EXTERNAL_DATABASE_TYPES.length)} external engines share one interface.`);
    // The ordinal counts the table's rows: every external engine, then the embedded store.
    expect(SHIPPED_DATABASE_TYPES).toHaveLength(EXTERNAL_DATABASE_TYPES.length + 1);
    expect(hub).toContain(`The ${ordinal(SHIPPED_DATABASE_TYPES.length)} row is the embedded LibreDB store`);
    expect(hub).toContain(
      "Prometheus, InfluxDB, Apache Kafka, MQTT, RabbitMQ, OPC UA, MTConnect, Modbus, SNMP, Oxia, S3-compatible object storage and Kubernetes are read-only: Studio calls only read APIs",
    );
    expect(hub).toContain(`of one of the ${word(EXTERNAL_DATABASE_TYPES.length)} drivers above`);
  });

  test("the three keywords, the mirror and both CSV descriptions", () => {
    const chart = parseYaml(read("charts/libredb-studio/Chart.yaml")) as {
      readonly version: string;
      readonly keywords: readonly string[];
    };
    const databend = chart.keywords.indexOf("databend");
    expect(chart.keywords.slice(databend + 1, databend + 4)).toEqual(["s3", "object-storage", "minio"]);
    const readme = read("charts/libredb-studio/README.md");
    expect(readme).toContain(`supporting ${word(EXTERNAL_DATABASE_TYPES.length)} engines - `);
    expect(readme).toContain(
      "InfluxDB 3, Oxia, Databend, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B.",
    );
    expect(readme).toContain(`--version ${chart.version} \\`);
    expect(read("operator/helm-charts/libredb-studio/Chart.yaml")).toBe(read("charts/libredb-studio/Chart.yaml"));
    const csv = parseYaml(
      read("operator/config/manifests/bases/libredb-studio-operator.clusterserviceversion.yaml"),
    ) as {
      readonly metadata: { readonly annotations: { readonly description: string } };
      readonly spec: { readonly description: string };
    };
    expect(csv.metadata.annotations.description).toContain(`for ${word(EXTERNAL_DATABASE_TYPES.length)} engines - `);
    expect(csv.metadata.annotations.description).toContain(
      "Oxia, Databend, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B - with AI-powered query assistance.",
    );
    expect(flat(csv.spec.description)).toContain(
      "Oxia, Databend, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B from the browser",
    );
  });

  test("FEATURES has the Object Storage group in its place, naming the networks of LINK_LOCAL_NETWORKS", () => {
    const features = read("docs/FEATURES.md");
    expect(features).toContain(FEATURES_GROUP);
    expect(features.indexOf("*   **Vector Databases:**")).toBeLessThan(features.indexOf("*   **Object Storage:**"));
    expect(features.indexOf("*   **Object Storage:**")).toBeLessThan(features.indexOf("*   **Embedded Stores:**"));
    // The group names the two link-local CIDRs and AWS's IPv6 metadata address in words; the NAT64 entry is a form
    // of 169.254.0.0/16. A network added to LINK_LOCAL_NETWORKS fails case 46 until this group is re-read too.
    for (const words of networkWords().filter((words) => words !== "NAT64")) {
      expect(FEATURES_GROUP, words).toContain(words === "fd00:ec2::254" ? "AWS's IPv6 metadata address" : words);
    }
    expect(flat(features)).toContain(
      "Milvus, Qdrant, Weaviate, Oxia, S3-compatible object storage and Kubernetes have no count grammar here",
    );
  });

  test("BRAND_MESSAGING counts the external engines and carries rule 9", () => {
    const brand = read("docs/BRAND_MESSAGING.md");
    expect(brand).toContain(`2. One tab, ${word(engines)} engines.`);
    expect(brand).toContain(`### Door 2: One tab, ${word(engines)} engines.`);
    expect(brand).toContain(`- **Promise:** ${word(engines)} engines in one interface`);
    expect(brand).toContain(`- **Proof:** ${word(engines)} providers, each with its own reference document`);
    expect(brand).toContain(`| ${Word(engines)} database engines | One reference document per engine:`);
    expect(brand).toContain(
      "Qdrant, Weaviate, Oxia, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B. One more, `libredb.md`, is the embedded provider",
    );
    expect(brand).toContain(`against ${word(engines)} here.`);
    expect(brand).toContain(`"${Word(engines)} engines" beats "extensive database support".`);
    expect(brand).toContain(`against ${word(engines)} shipped.`);
    expect(brand).not.toContain("twenty-seven");
    const rules = brand.split("\n");
    const rule8 = rules.findIndex((line) => line.startsWith("8. **AI is not described as magic.**"));
    expect(rules[rule8 + 1]).toBe(BRAND_RULE_9);
  });

  test("the index row, the directory note and every fixture row match the code and the compose file", () => {
    const index = read("docs/providers/README.md");
    const lines = index.split("\n");
    const influxdb3 = lines.findIndex((line) => line.startsWith("| InfluxDB 3 (SQL) | `influxdb3` |"));
    expect(lines[influxdb3 + 1]).toBe(PROVIDERS_INDEX_ROW);
    expect(lines[influxdb3 + 2].startsWith("| Kubernetes | `kubernetes` |")).toBe(true);
    /*
     * MQTT, RABBITMQ AND OPC UA SIT BETWEEN THE PLATFORM AND THE EMBEDDED STORE, in that order, the
     * newest last. MQTT's row was MISSING from this index - the only shipped engine with no row at
     * all, merged before OPC UA and never added - and OPC UA was registered beside the gap. A review
     * counted the rows against `SHIPPED` and found the index one short; this assertion counts them now.
     */
    expect(lines[influxdb3 + 3].startsWith("| MQTT | `mqtt` |")).toBe(true);
    expect(lines[influxdb3 + 4].startsWith("| RabbitMQ | `rabbitmq` |")).toBe(true);
    expect(lines[influxdb3 + 5].startsWith("| OPC UA | `opcua` |")).toBe(true);
    expect(lines[influxdb3 + 6].startsWith("| MTConnect | `mtconnect` |")).toBe(true);
    expect(lines[influxdb3 + 7].startsWith("| Modbus | `modbus` |")).toBe(true);
    expect(lines[influxdb3 + 8].startsWith("| NETCONF | `netconf` |")).toBe(true);
    expect(lines[influxdb3 + 9].startsWith("| SNMP | `snmp` |")).toBe(true);
    expect(lines[influxdb3 + 10].startsWith("| Sparkplug B | `sparkplug` |")).toBe(true);
    expect(lines[influxdb3 + 11].startsWith("| LibreDB | `libredb` |")).toBe(true);
    expect(index).toContain(
      "Qdrant, Weaviate, InfluxDB, Oxia, Databend, S3, Kubernetes, MQTT, Firestore, RabbitMQ and OPC UA are)",
    );
    // And the index holds a row for EVERY shipped type-id, which is the rule it states about itself.
    const indexed = new Set(
      [...index.matchAll(/^\| [^|]+\| `([a-z0-9]+)` \|.*\]\(\.\/[a-z0-9]+\.md\) \|$/gm)].map((m) => m[1]),
    );
    expect([...SHIPPED_DATABASE_TYPES].filter((type) => !indexed.has(type))).toEqual([]);
    for (const fixture of S3_FIXTURES) {
      const row = lines.find((line) =>
        line.startsWith(`| S3-compatible object storage, ${fixture.name} | \`${fixture.service}\` |`),
      );
      expect(row, fixture.service).toBeDefined();
      const cells = row?.split(" | ") ?? [];
      expect(cells[3], fixture.service).toBe(hostPort(fixture.service));
      const profile = COMPOSE.services[fixture.service]?.profiles?.[0];
      expect(cells.at(-1), fixture.service).toBe(profile === undefined ? "*none* |" : `\`${profile}\` |`);
    }
    const paragraphAt = index.indexOf("**S3-compatible object storage has six fixtures");
    if (paragraphAt === -1) throw new Error("the fixtures index has no S3-compatible object storage paragraph");
    const paragraphEnd = index.indexOf("\n\n", paragraphAt);
    const paragraph = flat(index.slice(paragraphAt, paragraphEnd === -1 ? undefined : paragraphEnd));
    for (const fixture of S3_FIXTURES) expect(paragraph, fixture.service).toContain(`\`${fixture.service}\``);
    expect(paragraph).toContain("](../../docker/s3/README.md)");
    // A plain `up` starts every service with no profile; the one-shots are the ones that never restart.
    const alwaysOn = Object.entries(COMPOSE.services).filter(([, service]) => service.profiles === undefined);
    const oneShots = alwaysOn.filter(([, service]) => service.restart === "no").map(([name]) => name);
    const services = flat(index);
    expect(services).toContain(`Start the ${word(alwaysOn.length)} always-on services with a plain`);
    expect(services).toContain(`${word(alwaysOn.length - oneShots.length)} engine containers plus the one-shot`);
    const sidecars = lines.find((line) => line.includes("engine containers plus the one-shot")) ?? "";
    for (const name of oneShots) expect(sidecars, name).toContain(`\`${name}\``);
  });

  const ids = SHIPPED_DATABASE_TYPES.length;
  test("CLAUDE.md and DATABASE_PROVIDERS count the ids and draw S3", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toContain(
      `${word(EXTERNAL_DATABASE_TYPES.length)} external engines, plus the embedded LibreDB store`,
    );
    expect(claude).toContain(
      "`oxia`, `milvus`, `qdrant`, `weaviate`, `s3`, `kubernetes`, `rabbitmq`, `libredb`) extend `BaseDatabaseProvider` directly",
    );
    const providers = read("docs/DATABASE_PROVIDERS.md");
    // Two pairs of type-ids share one module each: elasticsearch and opensearch, influxdb and influxdb3.
    expect(providers).toContain(`${Word(ids)} type-ids are supported by ${word(ids - 2)} provider modules:`);
    expect(providers).toContain("│   ├── objectstore/            # Object Storage Providers");
    expect(providers).toContain(
      "├── S3Provider ─────────────────────────────┤ Object storage (AWS CLI read commands over the S3 REST API, read-only)",
    );
    expect(providers).toContain(
      "| S3-compatible object storage | `s3` | Object storage (AWS CLI read commands over the S3 REST API, read-only) | [providers/s3.md](./providers/s3.md) |",
    );
    expect(providers).toContain(
      "- **S3-compatible object storage** (one AWS CLI read command, or Studio's own `preview`): [providers/s3.md](./providers/s3.md).",
    );
    expect(flat(providers)).toContain(
      "Qdrant, Weaviate, Oxia, Databend, S3-compatible object storage, Kubernetes, or LibreDB.",
    );
    /*
     * AND THE TABLE UNDER THE COUNT HOLDS EVERY SHIPPED TYPE-ID. The numeral was swept to
     * thirty-three while the table stayed thirty rows - BigQuery, MQTT and OPC UA missing, two of
     * them for a release each - and nothing noticed, because every guard here counted the numeral.
     * This counts the MEMBERSHIP, which is the half that was unguarded.
     */
    const tabled = new Set(
      [...providers.matchAll(/^\| [^|]+\| `([a-z0-9]+)` \|[^|]*\| \[providers\/[a-z0-9]+\.md\]/gm)].map((m) => m[1]),
    );
    expect([...SHIPPED_DATABASE_TYPES].filter((type) => !tabled.has(type))).toEqual([]);
    expect(tabled.size).toBe(SHIPPED_DATABASE_TYPES.length);
  });

  test("the editor and schema-diff guides name the S3 module, the non-SQL count and the pagination count", () => {
    expect(read("docs/editor/README.md")).toContain(
      "`src/lib/db/providers/keyvalue/oxia/editor-syntax.ts`, `src/lib/db/providers/objectstore/s3/editor-syntax.ts`, `src/lib/db/providers/platform/kubernetes/editor-syntax.ts` |",
    );
    const nonSql = SHIPPED_DATABASE_TYPES.filter((type) => !readsSqlText(type)).length;
    const optimization = read("docs/editor/query-optimization.md");
    expect(optimization).toContain(
      `Qdrant, Weaviate, Oxia, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B are the ${word(nonSql)} types whose query text is not SQL at all**`,
    );
    expect(optimization).toContain(`holds exactly those ${word(nonSql)},`);
    expect(provider.getCapabilities().supportsResultPagination).toBe(false);
    expect(optimization).toContain("Seventeen providers cannot serve page two.");
    expect(optimization).toContain("Qdrant, Weaviate, Oxia and S3-compatible object storage answer it with page one.");
    expect(optimization).toContain("The S3 row names no operation and, like the Oxia row, is the gate's whole answer:");
    expect(optimization).toContain(
      "a Qdrant request, an `oxia client` read command, an AWS CLI read command, a kubectl statement, a NETCONF read request, a Sparkplug read request or an SNMP walk is not judged by a SQL reader",
    );
    expect(flat(read("docs/SCHEMA_DIFF.md"))).toContain(
      "Qdrant, Weaviate, Oxia, S3-compatible object storage and Kubernetes receive an explanatory",
    );
  });

  test("the four Parquet packages are recorded at the versions and licences installed", () => {
    const licenses = read("docs/THIRD_PARTY_LICENSES.md");
    const manifest = JSON.parse(read("package.json")) as { readonly dependencies: Readonly<Record<string, string>> };
    // The preview imports fzstd itself only when it loads the codecs by path, and then package.json pins it.
    const codecsByPath = "fzstd" in manifest.dependencies;
    const direct = codecsByPath
      ? ["hyparquet", "hyparquet-compressors", "fzstd"]
      : ["hyparquet", "hyparquet-compressors"];
    for (const name of direct) {
      expect(manifest.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(installed(name).version, name).toBe(manifest.dependencies[name]);
    }
    for (const [name, reached] of [
      ["hyparquet", "direct dependency"],
      ["hyparquet-compressors", "direct dependency"],
      [
        "fzstd",
        codecsByPath ? "direct dependency (the preview imports it directly)" : "dependency of `hyparquet-compressors`",
      ],
      ["hysnappy", "dependency of `hyparquet-compressors`"],
    ] as const) {
      const row = licenses.split("\n").find((line) => line.startsWith(`| [\`${name}\`](`));
      expect(row, name).toBeDefined();
      const cells = row?.split(" | ") ?? [];
      expect(cells[1], name).toBe(installed(name).version);
      expect(cells[2]?.startsWith(installed(name).license), name).toBe(true);
      expect(cells[3], name).toContain(reached);
    }
    expect(licenses).toContain(
      codecsByPath
        ? "Only `src/lib/db/providers/objectstore/s3/preview-parquet.ts` loads three of them, through a dynamic import"
        : "Only `src/lib/db/providers/objectstore/s3/preview-parquet.ts` loads the four, through a dynamic import",
    );
  });

  const provided = ids - 2;
  const noStatistics = SHIPPED_DATABASE_TYPES.filter(
    (type) => engineServerDialect(type).statistics === "unsupported",
  ).length;
  test("AGENT.md counts the type-ids it names by rule", () => {
    const agent = read("docs/AGENT.md");
    const prose = flat(agent);
    // The engines an agent run cannot read through are named by the rule, never counted (issue #1614).
    expect(prose).toContain("reach every engine the read-only profile refuses");
    expect(prose).toContain("including every engine where an agent run cannot read anything at all");
    expect(prose).toContain(`on the other ${word(noStatistics)} \`readSchemaStatistics\` answers`);
    expect(prose).toContain(`On the other ${word(provided)} it is **one**`);
    // Matched from "other", since the sentence that says it opens with "The" now that it stands on its own line.
    expect(prose).toContain(`other ${word(noStatistics)} hold no statistics this run`);
    expect(prose).toContain(`so all ${word(ids)} ids pass it`);
    expect(prose).toContain(`Collapsing the other ${word(provided)} onto the composed one`);
    // The engines composed SQL serves are named by the resolver that answers them, never counted (#1821).
    expect(agent).toContain('the engines `enginesSupporting("catalogRead", "planEstimate")` answers');
  });

  test("AGENT_GUIDE and AGENT_DATA_FLOW count the type-ids and name S3", () => {
    const guide = flat(read("docs/AGENT_GUIDE.md"));
    expect(guide).toContain(`which is the other ${word(provided)} (MySQL,`);
    expect(guide).toContain(
      "Qdrant, Weaviate, Oxia, Databend, S3-compatible object storage, Kubernetes, Modbus, NETCONF, SNMP, Sparkplug B and the bundled LibreDB store)",
    );
    expect(guide).toContain(`so it reaches all ${word(ids)} engines.`);
    expect(guide).toContain(
      "On S3-compatible object storage that is one AWS CLI read command, or Studio's own `preview`, in a block tagged `s3`, which the run never executes.",
    );
    expect(guide).toContain(
      "So on every other id in the `DatabaseType` union (`src/lib/types.ts`) an Agent-mode run cannot read anything.",
    );
    expect(guide).toContain(`no longer takes this path at all on the other ${word(provided)}:`);
    expect(guide).toContain(`on the other ${word(noStatistics)} the plan is told that this engine holds none`);
    const flow = flat(read("docs/AGENT_DATA_FLOW.md"));
    expect(flow).toContain(`and the other ${word(provided)} by asking the connection's own provider`);
    expect(flow).toContain(
      "Never an etcd, Milvus, Qdrant, Weaviate, InfluxDB (InfluxQL), Oxia, S3-compatible object storage or Kubernetes statement",
    );
    expect(flow).toContain("which those eight do");
    expect(flow).toContain(
      "an S3 command names buckets and object keys, and a kubectl statement names namespaces and objects",
    );
    expect(flow).toContain(
      `a server-side enum with ${word(ids)} members, so what it discloses is which of ${word(ids)} engines this`,
    );
    expect(flow).toContain(`And two of the ${word(provided)}, the embedded`);
    expect(flow).toContain(`On the other ${word(provided)} it invokes \`db.schema.read\``);
    expect(flow).toContain(
      `**${Word(provided)} counts type-ids the factory can build, not engines a user would name**`,
    );
    expect(flow).toContain(`the engine catalog holds ${word(ids)}, two of them supply a \`catalogCapture\``);
    expect(flow).toContain(`libSQL is one of the ${word(provided)} and not one of the two`);
    expect(flow).toContain(
      "- On S3-compatible object storage the grounding carries bucket names only, never an object key, a prefix, a size or any object content (objects are listed by the Keys panel, not by the object walk).",
    );
    /*
     * COUNTED FROM THE DECLARATIONS AND NOT FROM THE SENTENCE. `declaresForeignKeys: false` is set by every shipped
     * type-id but the eight SQL engines that declare them, so the list names `SHIPPED_DATABASE_TYPES.length - 8`.
     * The sentence once carried that number and named fewer: it said twenty-four and named twenty-four while BigQuery,
     * Firestore, OPC UA and Snowflake were missing. It names them now and counts none (#1614), so the count is held
     * here, on the names between the parentheses.
     */
    const noKeys = flow.split("On every engine that declares no foreign keys at all (")[1]?.split(") this block")[0];
    expect(noKeys?.split(/, | and /)).toHaveLength(ids - 8);
    expect(flow).toContain(
      "Qdrant, Weaviate, Oxia, Databend, S3-compatible object storage, Kubernetes, SNMP and Sparkplug B) this block carries no relations",
    );
    expect(flow).toContain(`replaces them on the other ${word(provided)}.`);
    expect(flow).toContain(
      "nothing at all for an etcd, Milvus, Qdrant, Weaviate, InfluxDB (InfluxQL), Oxia, S3-compatible object storage or Kubernetes statement",
    );
  });

  test("every list that names Databend and claims to be complete names S3 too", () => {
    const readme = read("README.md");
    expect(readme).toContain(
      "InfluxDB 3 (SQL), Oxia, S3-compatible object storage, Kubernetes, MTConnect and Modbus with SSL/TLS and SSH Tunnel support",
    );
    expect(readme).toContain(
      "InfluxDB 3 (SQL), Oxia, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP, Sparkplug B | Web, Mobile |",
    );
    expect(readme).toContain(
      "InfluxDB 3 (SQL), Oxia, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP, or Sparkplug B)",
    );
    const zh = read("README_zh.md");
    expect(zh).toContain(
      "InfluxDB 3 (SQL)、Oxia、S3-compatible object storage、Kubernetes、MTConnect、Modbus、NETCONF、Sparkplug B，支持 SSL/TLS 与 SSH 隧道",
    );
    expect(zh).toContain(
      "InfluxDB 3 (SQL)、Oxia、S3-compatible object storage、Kubernetes、OPC UA、MTConnect、Modbus、NETCONF、SNMP、Sparkplug B | Web、移动端 |",
    );
    expect(zh).toContain(
      "InfluxDB 3 (SQL)、Oxia、S3-compatible object storage、Kubernetes、OPC UA、MTConnect、Modbus、NETCONF、SNMP 或 Sparkplug B）",
    );
    expect(read("README_ko.md")).toContain(
      "InfluxDB 3 (SQL), Oxia, S3-compatible object storage, Kubernetes, MTConnect, Modbus, NETCONF, SNMP, Sparkplug B에 연결할 수 있으며",
    );
    // The newest-engine history names Apache Spark as the newest in README.md, OPC UA one step back, Snowflake before
    // OPC UA, Firestore before RabbitMQ, MQTT before Firestore, Kubernetes before MQTT, S3 before Kubernetes and
    // Databend before S3; the translations carry the shorter chain, which runs from Apache Spark to OPC UA and
    // straight back to MQTT. The chain is a claim about ORDER, so each link is pinned at both ends: an engine added
    // without moving the head leaves the previous head claiming a title it no longer holds, which is exactly what
    // this change did to Kubernetes until the `not` assertions below were added.
    expect(readme).toContain("Weaviate is the newest: Weaviate's own REST requests typed in the editor");
    expect(readme).toContain("Sparkplug B came before Weaviate: one broker read over MQTT");
    expect(readme).not.toContain("Sparkplug B is the newest");
    expect(readme).toContain("SNMP came before Sparkplug B: one agent read over UDP");
    expect(readme).not.toContain("SNMP is the newest");
    expect(readme).toContain("NETCONF came before SNMP: one network device read over NETCONF on SSH");
    expect(readme).toContain("Modbus came before NETCONF: one device or gateway read over a raw socket");
    expect(readme).toContain("MTConnect came before Modbus: one agent read over HTTP");
    expect(readme).not.toContain("Modbus is the newest");
    expect(readme).not.toContain("NETCONF is the newest");
    expect(readme).not.toContain("MTConnect is the newest");
    expect(readme).toContain("Apache Spark came before MTConnect: SQL typed in the editor");
    expect(readme).not.toContain("Apache Spark is the newest");
    expect(readme).not.toContain("OPC UA is the newest");
    expect(readme).toContain("OPC UA came before Apache Spark: one `opc.tcp` session reads");
    expect(readme).not.toContain("Snowflake is the newest");
    expect(readme).toContain("Snowflake came before OPC UA: SQL typed in the editor");
    expect(readme).not.toContain("RabbitMQ is the newest");
    expect(readme).not.toContain("Firestore is the newest");
    expect(readme).toContain("Firestore came before RabbitMQ: the Admin SDK query chain");
    expect(readme).not.toContain("MQTT is the newest");
    expect(readme).toContain("MQTT came before Firestore: one subscription reads");
    expect(readme).not.toContain("Kubernetes is the newest");
    expect(readme).toContain("Kubernetes came before MQTT: kubectl read commands");
    expect(readme).toContain("S3-compatible object storage came before Kubernetes: AWS CLI read commands");
    expect(readme).toContain("Databend came before S3-compatible object storage: ");
    expect(zh).toContain("MTConnect 在 Modbus 之前：");
    expect(zh).toContain("OPC UA 在 Apache Spark 之前：");
    expect(zh).toContain("Sparkplug B 是最新的一个");
    expect(zh).toContain("SNMP 在 Sparkplug B 之前：");
    expect(zh).not.toContain("SNMP 是最新的一个");
    expect(zh).toContain("NETCONF 在 SNMP 之前：");
    expect(zh).toContain("Modbus 在 NETCONF 之前：");
    expect(zh).not.toContain("Modbus 是最新的一个");
    expect(zh).not.toContain("NETCONF 是最新的一个");
    expect(zh).not.toContain("MTConnect 是最新的一个");
    expect(zh).not.toContain("OPC UA 是最新的一个");
    expect(zh).toContain("OPC UA 在 Apache Spark 之前：");
    expect(zh).not.toContain("MQTT 是最新的一个");
    expect(zh).toContain("MQTT 在 OPC UA 之前：");
    expect(zh).not.toContain("Kubernetes 是最新的一个");
    expect(zh).toContain("Kubernetes 在 MQTT 之前：");
    expect(zh).toContain("S3-compatible object storage 在 Kubernetes 之前：");
    expect(zh).toContain("Databend 在 S3-compatible object storage 之前：");
    expect(zh).not.toContain("Databend 是最新的一个");
    expect(zh).toContain("它在 MinIO、Silo、Garage 和 RustFS 上验证过，没有在任何托管服务上验证过。");
    const ko = read("README_ko.md");
    expect(ko).toContain("MinIO, Silo, Garage, RustFS에서 검증되었으며 호스팅 서비스에서는 검증되지 않았습니다.");
    expect(ko).toContain("Modbus 이전에 추가된 엔진은 MTConnect입니다.");
    expect(ko).toContain("가장 최근에 추가된 엔진은 Sparkplug B입니다.");
    expect(ko).toContain("Sparkplug B 이전에 추가된 엔진은 SNMP입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 SNMP입니다.");
    expect(ko).toContain("SNMP 이전에 추가된 엔진은 NETCONF입니다.");
    expect(ko).toContain("NETCONF 이전에 추가된 엔진은 Modbus입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 Modbus입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 NETCONF입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 MTConnect입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 OPC UA입니다.");
    expect(ko).toContain("Apache Spark 이전에 추가된 엔진은 OPC UA입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 MQTT입니다.");
    expect(ko).toContain("OPC UA 이전에 추가된 엔진은 MQTT입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 Kubernetes입니다.");
    expect(ko).toContain("MQTT 이전에 추가된 엔진은 Kubernetes입니다.");
    expect(ko).toContain("S3-compatible object storage는 Kubernetes보다 먼저 추가된 엔진입니다.");
    expect(ko).toContain("Databend는 S3-compatible object storage보다 먼저 추가된 엔진입니다.");
    expect(ko).not.toContain("가장 최근에 추가된 엔진은 Databend입니다");
    // The seed table's type list is the union's members, so every README that carries it names s3.
    for (const [file, separator] of [
      ["README.md", ", "],
      ["README_zh.md", "、"],
    ] as const) {
      const row = read(file)
        .split("\n")
        .find((line) => line.startsWith("| `connections[].type` |"));
      const listed = (row?.match(/`[a-z0-9]+`/g) ?? []).map((cell) => cell.slice(1, -1)).sort();
      expect(listed, file).toEqual([...SHIPPED_DATABASE_TYPES].sort());
      // The tail stays in registry order, with the two industrial engines and then the device protocol
      // between the platform and the store (#1677, then #1722: an agent reads the machines an address
      // space stands in front of, then #1721: the devices the plant's network is made of).
      expect(row, file).toContain(
        `\`oxia\`${separator}\`s3\`${separator}\`kubernetes\`${separator}\`opcua\`${separator}\`mtconnect\`${separator}\`modbus\`${separator}\`netconf\`${separator}\`snmp\`${separator}\`sparkplug\`${separator}\`libredb\``,
      );
    }
    expect(read("docs/BRAND_MESSAGING.md")).toContain(
      "Milvus, Qdrant, Weaviate, Oxia, S3-compatible object storage and Kubernetes, with SSO and audit",
    );
    expect(read("docs/FEATURES.md")).toContain(
      "Qdrant, Weaviate, Oxia, Databend, S3-compatible object storage, Kubernetes and LibreDB show no editing control at all",
    );
    expect(provider.getCapabilities().supportsInlineRowEdit).toBe(false);
  });
});
