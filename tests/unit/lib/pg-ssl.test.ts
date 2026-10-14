import { describe, expect, test } from "bun:test";
import { pgSslConfig, type PgSslConfig } from "@/lib/pg-ssl";

const OFF: PgSslConfig = false;
const UNVERIFIED: PgSslConfig = { rejectUnauthorized: false };
const VERIFIED: PgSslConfig = { rejectUnauthorized: true };

describe("pgSslConfig", () => {
  // The answers PostgresStorageProvider's private buildSSLConfig() gave before it moved
  // here, one row per branch, so the storage pool and the governance pool cannot drift.
  test("every sslmode and ssl parameter case answers exactly what the storage provider's private method answered", () => {
    const cases: Array<[string, PgSslConfig]> = [
      ["postgresql://db.example.com:5432/app?sslmode=disable", OFF],
      ["postgresql://db.example.com:5432/app?sslmode=DISABLE", OFF],
      ["postgresql://db.example.com:5432/app?sslmode=verify-system", VERIFIED],
      ["postgresql://localhost:5432/app?sslmode=verify-system", VERIFIED],
      ["postgresql://db.example.com:5432/app?sslmode=require", UNVERIFIED],
      ["postgresql://db.example.com:5432/app?sslmode=Require", UNVERIFIED],
      ["postgresql://db.example.com:5432/app?sslmode=prefer", UNVERIFIED],
      ["postgresql://db.example.com:5432/app?sslmode=verify-ca", UNVERIFIED],
      ["postgresql://db.example.com:5432/app?sslmode=verify-full", UNVERIFIED],
      ["postgresql://localhost:5432/app?sslmode=require", UNVERIFIED],
      // sslmode wins over ssl when both are present.
      ["postgresql://db.example.com:5432/app?sslmode=disable&ssl=true", OFF],
      ["postgresql://localhost:5432/app?sslmode=require&ssl=false", UNVERIFIED],
      // An sslmode this function does not know falls through to the ssl parameter.
      ["postgresql://db.example.com:5432/app?sslmode=allow&ssl=false", OFF],
      ["postgresql://localhost:5432/app?sslmode=allow", OFF],
      ["postgresql://db.example.com:5432/app?sslmode=allow", UNVERIFIED],
      ["postgresql://db.example.com:5432/app?ssl=false", OFF],
      ["postgresql://db.example.com:5432/app?ssl=0", OFF],
      ["postgresql://db.example.com:5432/app?ssl=no", OFF],
      ["postgresql://db.example.com:5432/app?ssl=FALSE", OFF],
      ["postgresql://localhost:5432/app?ssl=true", UNVERIFIED],
      ["postgresql://localhost:5432/app?ssl=1", UNVERIFIED],
      ["postgresql://localhost:5432/app?ssl=yes", UNVERIFIED],
      ["postgresql://localhost:5432/app?ssl=TRUE", UNVERIFIED],
      ["postgresql://localhost:5432/app?ssl=maybe", OFF],
      ["postgresql://db.example.com:5432/app?ssl=maybe", UNVERIFIED],
      // A string the URL parser refuses has no host, which is not a local host.
      ["not a url", UNVERIFIED],
      ["", UNVERIFIED],
    ];
    for (const [url, expected] of cases) {
      expect({ url, ssl: pgSslConfig(url) }).toEqual({ url, ssl: expected });
    }
  });

  test("a local host without sslmode keeps TLS off and a remote host keeps today's default", () => {
    const localHosts = [
      "localhost",
      "LOCALHOST",
      "host.docker.internal",
      "docker.for.mac.localhost",
      "docker.for.win.localhost",
      "gateway.docker.internal",
      "127.0.0.1",
      "127.10.20.30",
    ];
    for (const host of localHosts) {
      const url = `postgresql://user:secret@${host}:5432/app`;
      expect({ url, ssl: pgSslConfig(url) }).toEqual({ url, ssl: OFF });
    }

    // URL keeps the brackets of an IPv6 hostname, so "[::1]" never matched the "::1" entry
    // and counted as remote. The move keeps that answer; changing it is a behaviour change.
    const remoteHosts = ["db.example.com", "10.0.0.5", "postgres", "128.0.0.1", "localhost.example.com", "[::1]"];
    for (const host of remoteHosts) {
      const url = `postgresql://user:secret@${host}:5432/app`;
      expect({ url, ssl: pgSslConfig(url) }).toEqual({ url, ssl: UNVERIFIED });
    }
  });
});
