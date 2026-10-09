import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PostgreSQLIcon,
  MySQLIcon,
  SQLiteIcon,
  MongoDBIcon,
  RedisIcon,
  OracleIcon,
  MSSQLIcon,
  LibreDBIcon,
  CouchbaseIcon,
  ClickHouseIcon,
  DruidIcon,
  ElasticsearchIcon,
  OpenSearchIcon,
  TrinoIcon,
  CassandraIcon,
  PrometheusIcon,
  KafkaIcon,
  EtcdIcon,
  Db2Icon,
  Neo4jIcon,
  QdrantIcon,
  MilvusIcon,
  InfluxDBIcon,
  OxiaIcon,
  DatabendIcon,
} from "@/components/icons/db-icons";

describe("db-icons", () => {
  const icons = [
    { name: "PostgreSQLIcon", Component: PostgreSQLIcon },
    { name: "MySQLIcon", Component: MySQLIcon },
    { name: "SQLiteIcon", Component: SQLiteIcon },
    { name: "MongoDBIcon", Component: MongoDBIcon },
    { name: "RedisIcon", Component: RedisIcon },
    { name: "OracleIcon", Component: OracleIcon },
    { name: "MSSQLIcon", Component: MSSQLIcon },
    { name: "LibreDBIcon", Component: LibreDBIcon },
    { name: "CouchbaseIcon", Component: CouchbaseIcon },
    { name: "ClickHouseIcon", Component: ClickHouseIcon },
    { name: "DruidIcon", Component: DruidIcon },
    // This list is hand-written and NOT enforced by any type, so a new provider's
    // icon is only covered because its name was added here (#424 Phase 1).
    { name: "ElasticsearchIcon", Component: ElasticsearchIcon },
    { name: "OpenSearchIcon", Component: OpenSearchIcon },
    { name: "TrinoIcon", Component: TrinoIcon },
    { name: "CassandraIcon", Component: CassandraIcon },
    { name: "PrometheusIcon", Component: PrometheusIcon },
    { name: "KafkaIcon", Component: KafkaIcon },
    { name: "EtcdIcon", Component: EtcdIcon },
    { name: "Db2Icon", Component: Db2Icon },
    { name: "Neo4jIcon", Component: Neo4jIcon },
    { name: "QdrantIcon", Component: QdrantIcon },
    { name: "MilvusIcon", Component: MilvusIcon },
    { name: "InfluxDBIcon", Component: InfluxDBIcon },
    { name: "OxiaIcon", Component: OxiaIcon },
    // Databend's published icon rather than a drawn mark: fixed fills, no stroke (see its own test below).
    { name: "DatabendIcon", Component: DatabendIcon, brandAsset: true },
  ];

  for (const { name, Component, brandAsset } of icons) {
    test(`${name} renders an SVG element`, () => {
      const html = renderToStaticMarkup(React.createElement(Component, { className: "w-4 h-4" }));
      expect(html).toContain("<svg");
      expect(html).toContain("w-4 h-4");
    });

    test(`${name} passes extra props`, () => {
      const html = renderToStaticMarkup(
        React.createElement(Component, { "data-testid": `icon-${name}` } as React.SVGAttributes<SVGSVGElement>),
      );
      expect(html).toContain(`data-testid="icon-${name}"`);
    });

    test(`${name} follows the embedded-mode icon contract`, () => {
      // Embedded-mode icon contract: DB marks scale from the className alone at stroke
      // weight 1.5. An HTML width/height attribute would win over an embedding host's
      // size classes, so the icon would render at a fixed 24px inside that host only.
      // A vendor's published icon has no stroke to weigh, but it scales the same way.
      const html = renderToStaticMarkup(React.createElement(Component, { className: "w-3.5 h-3.5" }));
      if (!brandAsset) expect(html).toContain('stroke-width="1.5"');
      expect(html).not.toMatch(/\swidth="/);
      expect(html).not.toMatch(/\sheight="/);
    });
  }

  test("InfluxDBIcon is a stroked mark on the house 24-unit grid (InfluxDB spec A.4)", () => {
    // One generic time-series mark drawn for Studio, shared by both InfluxDB types, never the vendor's logo (E19).
    const html = renderToStaticMarkup(React.createElement(InfluxDBIcon));
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('fill="none"');
  });

  test("DatabendIcon is Databend's published icon, unaltered (databendlabs/databend-docs#3512)", () => {
    // The brand guidelines (https://www.databend.com/brand/) forbid changing the logo's shapes, colours or proportions.
    const html = renderToStaticMarkup(React.createElement(DatabendIcon, { className: "text-hue-red-alt" }));
    // A square around the mark's own bounds (x 23.1 to 119.05, y 0 to 58.32 in the published file's units), so the icon
    // keeps its proportions on the same square footprint as the 24-unit marks beside it.
    expect(html).toContain('viewBox="22 -20 98 98"');
    // The published colours, in the file's order. Nothing inherits the caller's colour, so the accent class every
    // surface passes cannot repaint it.
    expect([...html.matchAll(/fill="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "#B7E3FF",
      "#52AAFF",
      "#0175F2",
      "#015BCB",
      "#015BCB",
      "#015BCB",
      "#0175F2",
    ]);
    expect(html).not.toContain("currentColor");
    expect(html).not.toContain("stroke");
    // The six paths byte for byte: SHA-256 of their `d` attributes, joined by "\n", as published in
    // https://www.databend.com/img/resource/svg/light-databend-single.svg ("Icon · Light").
    const paths = [...html.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toHaveLength(6);
    expect(createHash("sha256").update(paths.join("\n")).digest("hex")).toBe(
      "f785f09847d68ad19488ab370ba952e1a16a4bd6a59be2fdd5b4984691904d76",
    );
    expect(html).toContain('<circle fill="#0175F2" cx="62.87" cy="46.71" r="2.28"></circle>');
  });
});
