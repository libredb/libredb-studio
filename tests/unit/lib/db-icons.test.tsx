import { describe, test, expect } from "bun:test";
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
  ];

  for (const { name, Component } of icons) {
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
      // .claude/rules/platform-integration.md: DB marks scale from the className alone
      // at stroke weight 1.5. An HTML width/height attribute would win over platform's
      // size classes, so the icon would render at 24px inside libredb-platform only.
      const html = renderToStaticMarkup(React.createElement(Component, { className: "w-3.5 h-3.5" }));
      expect(html).toContain('stroke-width="1.5"');
      expect(html).not.toMatch(/\swidth="/);
      expect(html).not.toMatch(/\sheight="/);
    });
  }
});
