import { describe, test, expect } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PostgreSQLIcon,
  MySQLIcon,
  SQLiteIcon,
  MongoDBIcon,
  RedisIcon,
  OracleIcon,
  MSSQLIcon,
  DemoIcon,
} from '@/components/icons/db-icons';

describe('db-icons', () => {
  const icons = [
    { name: 'PostgreSQLIcon', Component: PostgreSQLIcon },
    { name: 'MySQLIcon', Component: MySQLIcon },
    { name: 'SQLiteIcon', Component: SQLiteIcon },
    { name: 'MongoDBIcon', Component: MongoDBIcon },
    { name: 'RedisIcon', Component: RedisIcon },
    { name: 'OracleIcon', Component: OracleIcon },
    { name: 'MSSQLIcon', Component: MSSQLIcon },
    { name: 'DemoIcon', Component: DemoIcon },
  ];

  for (const { name, Component } of icons) {
    test(`${name} renders an SVG element`, () => {
      const html = renderToStaticMarkup(
        React.createElement(Component, { className: 'w-4 h-4' })
      );
      expect(html).toContain('<svg');
      expect(html).toContain('w-4 h-4');
    });

    test(`${name} passes extra props`, () => {
      const html = renderToStaticMarkup(
        React.createElement(Component, { 'data-testid': `icon-${name}` } as React.SVGAttributes<SVGSVGElement>)
      );
      expect(html).toContain(`data-testid="icon-${name}"`);
    });
  }
});
