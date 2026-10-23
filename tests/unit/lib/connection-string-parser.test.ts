import { describe, test, expect } from "bun:test";
import {
  parseConnectionString,
  detectConnectionStringType,
  ENGINE_URI_SCHEMES,
  DATABEND_DSN_CAUTIONS,
  DATABEND_DSN_REFUSALS,
  DATABEND_SSLMODE_NOTICES,
  databendNotAppliedNotice,
  SNOWFLAKE_PASTE_SENTENCES,
} from "@/lib/connection-string-parser";
import { getDBConfig } from "@/lib/db-ui-config";
import { SPARK_PASTE_SENTENCES } from "@/lib/db/providers/sql/spark/sc-uri";
import type { SSLMode } from "@/lib/types";

// ─── parseConnectionString ──────────────────────────────────────────────────

describe("parseConnectionString", () => {
  // ── PostgreSQL ──────────────────────────────────────────────────────────

  describe("postgres:// URLs", () => {
    test("parses full postgres URL", () => {
      const result = parseConnectionString("postgres://admin:secret@localhost:5432/mydb");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("postgres");
      expect(result!.host).toBe("localhost");
      expect(result!.port).toBe("5432");
      expect(result!.user).toBe("admin");
      expect(result!.password).toBe("secret");
      expect(result!.database).toBe("mydb");
    });

    test("parses postgresql:// URL", () => {
      const result = parseConnectionString("postgresql://user:pass@db.example.com:5432/appdb");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("postgres");
      expect(result!.host).toBe("db.example.com");
      expect(result!.port).toBe("5432");
      expect(result!.database).toBe("appdb");
    });

    test("uses default port 5432 when port is omitted", () => {
      const result = parseConnectionString("postgres://user:pass@host/db");
      expect(result!.port).toBe("5432");
    });

    test("handles missing database", () => {
      const result = parseConnectionString("postgres://user:pass@host:5432");
      expect(result!.database).toBeUndefined();
    });

    test("handles missing credentials", () => {
      const result = parseConnectionString("postgres://host:5432/db");
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.host).toBe("host");
      expect(result!.database).toBe("db");
    });

    test("decodes URL-encoded username and password", () => {
      const result = parseConnectionString("postgres://user%40name:p%40ss%23word@host/db");
      expect(result!.user).toBe("user@name");
      expect(result!.password).toBe("p@ss#word");
    });

    test("percent-decodes the database name, and keeps a broken escape as written", () => {
      expect(parseConnectionString("postgres://us%3Aer:pw@host:5432/my%20db")!.database).toBe("my db");
      expect(parseConnectionString("postgres://u:pw@h:5432/%E5%9C%A8")!.database).toBe("在");
      expect(parseConnectionString("postgres://u:pw@h:5432/my%ZZdb")!.database).toBe("my%ZZdb");
      expect(parseConnectionString("postgres://u:pw@host:5432/")!.database).toBeUndefined();
    });
  });

  describe("postgres:// URL query parameters (libpq keywords)", () => {
    test("reads host, port, user and password from the query string", () => {
      const result = parseConnectionString("postgres:///app?host=db.example.com&port=6543&user=alice&password=secret");
      expect(result!.host).toBe("db.example.com");
      expect(result!.port).toBe("6543");
      expect(result!.user).toBe("alice");
      expect(result!.password).toBe("secret");
      expect(result!.database).toBe("app");
    });

    test("query parameters fill in fields the authority left out", () => {
      const result = parseConnectionString("postgres://localhost/app?user=alice");
      expect(result!.host).toBe("localhost");
      expect(result!.user).toBe("alice");
    });

    test("dbname= overrides the path database the way libpq does", () => {
      const result = parseConnectionString("postgres://alice@localhost/app?dbname=other");
      expect(result!.database).toBe("other");
    });

    test("query parameters override the authority the way libpq does", () => {
      const result = parseConnectionString("postgres://bob@db1.example.com:5432/app?host=db2.example.com&user=alice");
      expect(result!.host).toBe("db2.example.com");
      expect(result!.user).toBe("alice");
      expect(result!.port).toBe("5432");
    });

    test("query parameter values keep their percent-encoding as typed", () => {
      const result = parseConnectionString("postgres:///app?user=us%3Aer&password=pa%24%24word0");
      expect(result!.user).toBe("us:er");
      expect(result!.password).toBe("pa$$word0");
    });

    test("a double-encoded value stays double-encoded, not decoded twice", () => {
      const result = parseConnectionString("postgres:///app?password=literal%252Fvalue");
      expect(result!.password).toBe("literal%2Fvalue");
    });

    test("a plus in a query parameter value is a literal plus", () => {
      const result = parseConnectionString("postgres:///app?password=pa+ss");
      expect(result!.password).toBe("pa+ss");
    });

    test("a percent-encoded UTF-8 value decodes to the typed character", () => {
      const result = parseConnectionString("postgres:///app?user=us%C3%A9r");
      expect(result!.user).toBe("usér");
    });

    test("repeated query keys use the last value", () => {
      const result = parseConnectionString("postgres:///app?host=db1.example.com&host=db2.example.com");
      expect(result!.host).toBe("db2.example.com");
    });

    test("an empty last value still replaces an earlier one", () => {
      const result = parseConnectionString("postgres:///app?password=old&password=");
      expect(result!.password).toBe("");
    });

    test("a percent-encoded keyword name is decoded", () => {
      const result = parseConnectionString("postgres:///app?ho%73t=db.example.com");
      expect(result!.host).toBe("db.example.com");
    });

    test("an authority with only a userinfo and no host parses", () => {
      const result = parseConnectionString("postgresql://@/app?host=db.example.com&user=alice&password=secret");
      expect(result!.host).toBe("db.example.com");
      expect(result!.user).toBe("alice");
      expect(result!.password).toBe("secret");
      expect(result!.database).toBe("app");
    });

    test("a userinfo-only authority falls back to localhost like the empty form", () => {
      const result = parseConnectionString("postgres://alice@/app");
      expect(result!.host).toBe("localhost");
      expect(result!.user).toBe("alice");
    });
  });

  // ── MySQL ───────────────────────────────────────────────────────────────

  describe("mysql:// URLs", () => {
    test("parses full mysql URL", () => {
      const result = parseConnectionString("mysql://root:password@127.0.0.1:3306/testdb");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("mysql");
      expect(result!.host).toBe("127.0.0.1");
      expect(result!.port).toBe("3306");
      expect(result!.user).toBe("root");
      expect(result!.database).toBe("testdb");
    });

    test("uses default port 3306 when port is omitted", () => {
      const result = parseConnectionString("mysql://root:pass@host/db");
      expect(result!.port).toBe("3306");
    });

    test("handles mysql URL without credentials", () => {
      const result = parseConnectionString("mysql://host:3307/db");
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.port).toBe("3307");
    });

    test("percent-decodes a non-ASCII database name", () => {
      const result = parseConnectionString("mysql://u:pw@h:3306/caf%C3%A9");
      expect(result!.database).toBe("café");
    });
  });

  // ── MongoDB ─────────────────────────────────────────────────────────────

  describe("mongodb:// and mongodb+srv:// URLs", () => {
    test("parses standard mongodb URL", () => {
      const result = parseConnectionString("mongodb://user:pass@localhost:27017/mydb");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("mongodb");
      expect(result!.connectionString).toBe("mongodb://user:pass@localhost:27017/mydb");
      expect(result!.user).toBe("user");
      expect(result!.password).toBe("pass");
      expect(result!.database).toBe("mydb");
      expect(result!.host).toBe("localhost");
      expect(result!.port).toBe("27017");
    });

    test("parses mongodb+srv URL", () => {
      const result = parseConnectionString("mongodb+srv://user:pass@cluster.example.com/mydb");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("mongodb");
      expect(result!.connectionString).toContain("mongodb+srv://");
      expect(result!.user).toBe("user");
      expect(result!.database).toBe("mydb");
    });

    test("preserves full connection string", () => {
      const uri = "mongodb://user:pass@host1:27017,host2:27018/mydb?replicaSet=rs0";
      const result = parseConnectionString(uri);
      expect(result!.connectionString).toBe(uri);
    });

    test("parses mongodb URL without credentials", () => {
      const result = parseConnectionString("mongodb://localhost:27017/mydb");
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.database).toBe("mydb");
    });

    test("parses mongodb URL with query parameters", () => {
      const result = parseConnectionString("mongodb://user:pass@host/db?authSource=admin");
      expect(result!.database).toBe("db");
      expect(result!.user).toBe("user");
    });

    test("decodes URL-encoded password in mongodb URL", () => {
      const result = parseConnectionString("mongodb://user:p%40ss@host/db");
      expect(result!.password).toBe("p@ss");
    });

    test("handles mongodb URL without database path", () => {
      const result = parseConnectionString("mongodb://localhost:27017");
      expect(result!.type).toBe("mongodb");
      expect(result!.database).toBeUndefined();
    });

    // The driver applies `tls=true` for mongodb+srv itself, WITH chain verification, so the
    // form has to say the same thing rather than sit on its `disable` default while the
    // connection is in fact encrypted (D26). This stayed unset while `require` was the only
    // alternative, because require is rejectUnauthorized:false and the options object is a
    // second channel the driver reads - it would have stopped an Atlas certificate being
    // verified.
    test("mongodb+srv:// carries the verifying mode the scheme itself implies", () => {
      const result = parseConnectionString("mongodb+srv://user:pass@cluster0.abcde.mongodb.net/appdb");
      expect(result!.sslMode).toBe("verify-system");
      expect(result!.connectionString).toBe("mongodb+srv://user:pass@cluster0.abcde.mongodb.net/appdb");
    });

    test("plain mongodb:// with no TLS parameter says nothing about TLS", () => {
      expect(parseConnectionString("mongodb://user:pass@host:27017/appdb")!.sslMode).toBeUndefined();
    });

    // #842: an unescaped "@" in the password makes the auth/host split ambiguous instead
    // of refusing - `p@ss:w#rd` read as password "p", host "ss".
    describe("ambiguous credentials (#842)", () => {
      test("more than one literal @ before the host is refused, not guessed at", () => {
        const result = parseConnectionString("mongodb://user:p@ss:w#rd@realhost/db");
        expect(result!.credentialsAmbiguous).toBe(true);
        expect(result!.user).toBeUndefined();
        expect(result!.password).toBeUndefined();
        expect(result!.host).toBeUndefined();
        // the original paste is still there for the connection-string mode to use
        expect(result!.connectionString).toBe("mongodb://user:p@ss:w#rd@realhost/db");
      });

      test("a properly percent-encoded password never triggers it", () => {
        const result = parseConnectionString("mongodb://user:p%40ss@host/db");
        expect(result!.credentialsAmbiguous).toBeUndefined();
        expect(result!.password).toBe("p@ss");
      });

      test("a normal multi-host replica set string never triggers it", () => {
        const result = parseConnectionString("mongodb://user:pass@host1:27017,host2:27018/mydb?replicaSet=rs0");
        expect(result!.credentialsAmbiguous).toBeUndefined();
        expect(result!.host).toBe("host1");
      });

      test("a string with no credentials never triggers it", () => {
        expect(parseConnectionString("mongodb://host:27017/db")!.credentialsAmbiguous).toBeUndefined();
      });

      // The driver accepts this string: its authority ends at the first "/" or "?".
      test("an @ in an option value after a bare ? never triggers it", () => {
        const result = parseConnectionString("mongodb://user:pass@host:27017?appName=me@laptop");
        expect(result!.credentialsAmbiguous).toBeUndefined();
        expect(result!.user).toBe("user");
        expect(result!.password).toBe("pass");
      });
    });

    // #842: AWS DocumentDB's own console gives out `tlsCAFile=global-bundle.pem`, which the
    // driver reads as a path on the server process rather than the machine that pasted it.
    describe("tlsCAFile (#842)", () => {
      test("is reported rather than passed through silently", () => {
        const result = parseConnectionString("mongodb://user:pass@host:27017/db?tls=true&tlsCAFile=global-bundle.pem");
        expect(result!.tlsFileParam).toBe("tlsCAFile=global-bundle.pem");
        // a CA file pins the chain to that CA rather than the system store, so the form lands
        // on the mode whose CA box the paste banner points at
        expect(result!.sslMode).toBe("verify-ca");
      });

      test("pins an SRV string to verify-ca as well", () => {
        const uri = "mongodb+srv://user:pass@cluster0.example.net/db?tlsCAFile=ca.pem";
        expect(parseConnectionString(uri)!.sslMode).toBe("verify-ca");
      });

      test("leaves a relaxed certificate check on require", () => {
        const uri = "mongodb://user:pass@host/db?tls=true&tlsCAFile=ca.pem&tlsInsecure=true";
        expect(parseConnectionString(uri)!.sslMode).toBe("require");
      });

      test("leaves TLS off when the URI turns it off", () => {
        const uri = "mongodb://user:pass@host/db?tls=false&tlsCAFile=ca.pem";
        expect(parseConnectionString(uri)!.sslMode).toBe("disable");
      });

      test("is absent for a string with no file-path TLS parameter", () => {
        expect(parseConnectionString("mongodb://user:pass@host:27017/db?tls=true")!.tlsFileParam).toBeUndefined();
      });
    });
  });

  // ── Redis ───────────────────────────────────────────────────────────────

  describe("redis:// and rediss:// URLs", () => {
    test("parses redis URL", () => {
      const result = parseConnectionString("redis://default:secret@redis-host:6379/0");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("redis");
      expect(result!.host).toBe("redis-host");
      expect(result!.port).toBe("6379");
      expect(result!.user).toBe("default");
      expect(result!.password).toBe("secret");
      expect(result!.database).toBe("0");
    });

    test("parses rediss (TLS) URL", () => {
      const result = parseConnectionString("rediss://user:pass@tls-host:6380/1");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("redis");
      expect(result!.host).toBe("tls-host");
      expect(result!.port).toBe("6380");
    });

    test("uses default port 6379 when omitted", () => {
      const result = parseConnectionString("redis://host/0");
      expect(result!.port).toBe("6379");
    });

    // rediss:// IS the transport, exactly as https:// is for ClickHouse: ioredis only
    // negotiates TLS when a `tls` option is present, and that option is built from
    // `config.ssl`, so dropping the scheme sends plaintext to a TLS-only port and the
    // paste fails with a bare "Connection is closed." (measured, redis.md 4.3).
    test("carries the TLS intent of a rediss:// endpoint", () => {
      expect(parseConnectionString("rediss://user:pass@tls-host:6380/1")!.sslMode).toBe("require");
    });

    // The plain scheme is an explicit plaintext choice, not an absent one, so pasting
    // it must be able to clear a "require" the form is still holding.
    test("carries the plaintext intent of a redis:// endpoint", () => {
      expect(parseConnectionString("redis://redis-host:6379/0")!.sslMode).toBe("disable");
    });
  });

  // ── Oracle ──────────────────────────────────────────────────────────────

  describe("oracle:// URLs", () => {
    test("parses oracle URL", () => {
      const result = parseConnectionString("oracle://sys:oracle@dbhost:1521/orcl");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("oracle");
      expect(result!.host).toBe("dbhost");
      expect(result!.port).toBe("1521");
      expect(result!.user).toBe("sys");
      expect(result!.database).toBe("orcl");
    });

    test("uses default port 1521 when omitted", () => {
      const result = parseConnectionString("oracle://user:pass@host/db");
      expect(result!.port).toBe("1521");
    });
  });

  // ── Db2 LUW (#786) ──────────────────────────────────────────────────────

  describe("db2:// URLs", () => {
    test("parses a db2 URL into its fields", () => {
      const result = parseConnectionString("db2://db2inst1:secret@db2host:50001/TESTDB");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("db2");
      expect(result!.host).toBe("db2host");
      expect(result!.port).toBe("50001");
      expect(result!.user).toBe("db2inst1");
      expect(result!.password).toBe("secret");
      expect(result!.database).toBe("TESTDB");
      // A plain URL says nothing about TLS, so it leaves the form's mode alone.
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBeUndefined();
    });

    test("uses default port 50000 when omitted", () => {
      expect(parseConnectionString("db2://user:pass@host/SAMPLE")!.port).toBe("50000");
    });

    // `verify-system`, not `require`, by D26's rule and the Db2 provider's own: without verified
    // TLS the password can reach a server that impersonates the host, so TLS is verified unless a reader
    // chooses otherwise in the panel. A self-hosted Db2 with a private CA then fails closed on the
    // chain, and its CA certificate is what the panel asks for.
    test.each(["ssl=true", "ssl=1", "ssl=TRUE", "security=SSL", "security=ssl", "Security=SSL"])(
      "?%s asks for verified TLS",
      (query) => {
        const result = parseConnectionString(`db2://u:p@host:50001/TESTDB?${query}`);
        expect(result!.sslMode).toBe("verify-system");
        expect(result!.unmappedTLSParam).toBeUndefined();
      },
    );

    test.each(["ssl=false", "ssl=0"])("?%s asks for plaintext", (query) => {
      const result = parseConnectionString(`db2://u:p@host/TESTDB?${query}`);
      expect(result!.sslMode).toBe("disable");
    });

    test("an unknown value is reported rather than guessed", () => {
      expect(parseConnectionString("db2://u:p@host/TESTDB?ssl=maybe")!.unmappedTLSParam).toBe("ssl=maybe");
      expect(parseConnectionString("db2://u:p@host/TESTDB?security=CLEARTEXT")!.unmappedTLSParam).toBe(
        "security=CLEARTEXT",
      );
    });

    test("db2 publishes its scheme", () => {
      expect(ENGINE_URI_SCHEMES.db2).toBe("db2");
    });
  });

  // ── MSSQL / SQL Server ──────────────────────────────────────────────────

  describe("mssql:// and sqlserver:// URLs", () => {
    test("parses mssql URL", () => {
      const result = parseConnectionString("mssql://sa:pass@sqlserver:1433/master");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("mssql");
      expect(result!.host).toBe("sqlserver");
      expect(result!.port).toBe("1433");
      expect(result!.database).toBe("master");
    });

    test("parses sqlserver:// URL", () => {
      const result = parseConnectionString("sqlserver://sa:pass@host:1434/testdb");
      expect(result!.type).toBe("mssql");
      expect(result!.port).toBe("1434");
    });

    test("uses default port 1433 when omitted", () => {
      const result = parseConnectionString("mssql://sa:pass@host/db");
      expect(result!.port).toBe("1433");
    });
  });

  // ── Couchbase ───────────────────────────────────────────────────────────

  describe("couchbase:// and couchbases:// URLs", () => {
    test("parses full couchbase URL", () => {
      const uri = "couchbase://Administrator:password123@127.0.0.1:8091/travel";
      const result = parseConnectionString(uri);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("couchbase");
      expect(result!.host).toBe("127.0.0.1");
      expect(result!.port).toBe("8091");
      expect(result!.user).toBe("Administrator");
      expect(result!.password).toBe("password123");
      expect(result!.database).toBe("travel");
      expect(result!.connectionString).toBe(uri);
    });

    test("uses default management port 8091 when port is omitted", () => {
      const result = parseConnectionString("couchbase://Administrator:pass@cb-host/travel");
      expect(result!.type).toBe("couchbase");
      expect(result!.host).toBe("cb-host");
      expect(result!.port).toBe("8091");
    });

    test("uses default TLS management port 18091 for couchbases URLs", () => {
      const result = parseConnectionString("couchbases://Administrator:pass@secure-host/travel");
      expect(result!.type).toBe("couchbase");
      expect(result!.host).toBe("secure-host");
      expect(result!.port).toBe("18091");
      expect(result!.database).toBe("travel");
    });

    test("respects an explicit port on a couchbases URL", () => {
      const result = parseConnectionString("couchbases://user:pass@host:18092/travel");
      expect(result!.port).toBe("18092");
    });

    test("parses a Capella endpoint with no port and no bucket path", () => {
      const uri = "couchbases://cb.abc123.cloud.couchbase.com";
      const result = parseConnectionString(uri);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("couchbase");
      expect(result!.host).toBe("cb.abc123.cloud.couchbase.com");
      expect(result!.port).toBe("18091");
      expect(result!.database).toBeUndefined();
      expect(result!.connectionString).toBe(uri);
    });

    test("parses a Capella endpoint with credentials and a trailing slash", () => {
      const result = parseConnectionString("couchbases://app%40corp:s3cret@cb.abc123.cloud.couchbase.com/");
      expect(result!.host).toBe("cb.abc123.cloud.couchbase.com");
      expect(result!.user).toBe("app@corp");
      expect(result!.password).toBe("s3cret");
      expect(result!.database).toBeUndefined();
    });

    test("preserves the full original string including query parameters", () => {
      const uri = "couchbase://user:pass@cb-host:8091/travel?ssl=no_verify";
      const result = parseConnectionString(uri);
      expect(result!.connectionString).toBe(uri);
      expect(result!.database).toBe("travel");
    });

    test("takes the first host from a multi-node connection string", () => {
      const result = parseConnectionString("couchbase://user:pass@node1,node2,node3:8091/travel");
      expect(result!.host).toBe("node1");
      expect(result!.port).toBe("8091");
      expect(result!.database).toBe("travel");
    });

    test("handles couchbase URL without credentials", () => {
      const result = parseConnectionString("couchbase://cb-host:8091/travel");
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.database).toBe("travel");
    });

    test("decodes URL-encoded credentials and bucket name", () => {
      const result = parseConnectionString("couchbase://user%40corp:p%40ss%23word@cb-host/my%20bucket");
      expect(result!.user).toBe("user@corp");
      expect(result!.password).toBe("p@ss#word");
      expect(result!.database).toBe("my bucket");
    });

    test("keeps a bucket name containing a literal percent sign", () => {
      // "%" is legal in Couchbase bucket names and is not always a valid escape sequence.
      const result = parseConnectionString("couchbase://cb-host/100%");
      expect(result!.database).toBe("100%");
    });

    test("falls back to localhost when the URL carries no host", () => {
      const result = parseConnectionString("couchbase:///travel");
      expect(result!.host).toBe("localhost");
      expect(result!.database).toBe("travel");
    });

    // The Couchbase provider is HTTP-only and picks its scheme from `config.ssl`
    // (http-transport.ts buildTlsMaterial / `this.scheme = this.tls ? "https" : "http"`),
    // never from the pasted string, so couchbases:// has to arrive as a mode or the
    // request goes out as plain HTTP to the TLS management port 18091.
    test("carries the TLS intent of a couchbases:// endpoint", () => {
      expect(parseConnectionString("couchbases://user:pass@cb.abc123.cloud.couchbase.com/travel")!.sslMode).toBe(
        "require",
      );
    });

    test("carries the plaintext intent of a couchbase:// endpoint", () => {
      expect(parseConnectionString("couchbase://user:pass@cb-host:8091/travel")!.sslMode).toBe("disable");
    });

    test("returns null for a malformed couchbase URL", () => {
      expect(parseConnectionString("couchbase://:::bad")).toBeNull();
      expect(parseConnectionString("couchbases://:::bad")).toBeNull();
    });
  });

  // ── libSQL ──────────────────────────────────────────────────────────────

  describe("libsql:// URLs", () => {
    test("parses the URL Turso's own CLI prints, token and all", () => {
      const result = parseConnectionString(
        "libsql://libredb-probe-424-cevheri.aws-eu-west-1.turso.io?authToken=jwt-123",
      );

      expect(result).not.toBeNull();
      expect(result!.type).toBe("libsql");
      expect(result!.host).toBe("libredb-probe-424-cevheri.aws-eu-west-1.turso.io");
      // 443 under required TLS: `libsql://` has no plaintext form, and Turso serves
      // every database over HTTPS on a hostname that identifies the database.
      expect(result!.port).toBe("443");
      expect(result!.sslMode).toBe("require");
      // The credential is a TOKEN, and it rides in the query string rather than in
      // the authority - so it lands in `password`, which is the field the provider
      // sends as a bearer credential.
      expect(result!.password).toBe("jwt-123");
    });

    test("keeps an explicit port, for a self-hosted server behind TLS", () => {
      expect(parseConnectionString("libsql://sqld.internal:8443?authToken=t")!.port).toBe("8443");
    });

    test("falls back to a token written in the authority", () => {
      expect(parseConnectionString("libsql://ignored:jwt-456@db.turso.io")!.password).toBe("jwt-456");
    });

    test("names no database, because on libSQL the database IS the host", () => {
      expect(parseConnectionString("libsql://db.turso.io?authToken=t")!.database).toBeUndefined();
    });

    test("carries no token when the URL holds none, rather than an empty one", () => {
      expect(parseConnectionString("libsql://db.turso.io")!.password).toBeUndefined();
    });

    test("answers null for a libsql:// string that is not a URL", () => {
      expect(parseConnectionString("libsql://:::bad")).toBeNull();
    });

    test("detects the scheme without parsing it", () => {
      expect(detectConnectionStringType("libsql://db.turso.io?authToken=t")).toBe("libsql");
    });
  });

  // ── ClickHouse ──────────────────────────────────────────────────────────

  describe("clickhouse://, http:// and https:// URLs", () => {
    test("parses a full clickhouse:// URL", () => {
      const result = parseConnectionString("clickhouse://libredb:password123@127.0.0.1:8123/demo");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("clickhouse");
      expect(result!.host).toBe("127.0.0.1");
      expect(result!.port).toBe("8123");
      expect(result!.user).toBe("libredb");
      expect(result!.password).toBe("password123");
      expect(result!.database).toBe("demo");
    });

    test("uses the HTTP port 8123 when clickhouse:// omits it, not the native 9000", () => {
      const result = parseConnectionString("clickhouse://libredb:pass@ch-host/demo");
      expect(result!.type).toBe("clickhouse");
      expect(result!.host).toBe("ch-host");
      expect(result!.port).toBe("8123");
    });

    test("parses a plain http:// endpoint as ClickHouse", () => {
      const result = parseConnectionString("http://libredb:password123@localhost:18123/demo");
      expect(result!.type).toBe("clickhouse");
      expect(result!.port).toBe("18123");
      expect(result!.database).toBe("demo");
    });

    test("uses 8123 for an http:// endpoint with no port", () => {
      const result = parseConnectionString("http://ch-host/demo");
      expect(result!.type).toBe("clickhouse");
      expect(result!.port).toBe("8123");
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
    });

    test("uses 8443 for an https:// endpoint with no port", () => {
      const result = parseConnectionString("https://ch.example.clickhouse.cloud/default");
      expect(result!.type).toBe("clickhouse");
      expect(result!.host).toBe("ch.example.clickhouse.cloud");
      expect(result!.port).toBe("8443");
      expect(result!.database).toBe("default");
    });

    test("respects an explicit port on an https:// endpoint", () => {
      const result = parseConnectionString("https://user:pass@ch.example.clickhouse.cloud:9440/default");
      expect(result!.port).toBe("9440");
    });

    // Without this the fields alone cannot express TLS, so a pasted ClickHouse Cloud
    // URL would connect as plaintext HTTP to an https port and fail opaquely.
    test("carries the TLS intent of an https:// endpoint", () => {
      expect(parseConnectionString("https://ch.example.clickhouse.cloud/default")!.sslMode).toBe("require");
    });

    // http:// is an explicit choice, not an absent one: pasting it must be able to
    // turn TLS OFF, or a form still holding "require" from a previous edit would
    // send HTTPS to a plaintext endpoint.
    test("carries the plaintext intent of an http:// endpoint", () => {
      expect(parseConnectionString("http://ch-host:8123/demo")!.sslMode).toBe("disable");
    });

    // clickhouse:// names no transport, so it is the one scheme that must defer to
    // whatever TLS setting the form already carries.
    test("leaves the TLS intent unset for the scheme-neutral clickhouse:// form", () => {
      expect(parseConnectionString("clickhouse://ch-host:8123/demo")!.sslMode).toBeUndefined();
    });

    test("leaves the database undefined when the URL carries no path", () => {
      const result = parseConnectionString("clickhouse://ch-host:8123");
      expect(result!.type).toBe("clickhouse");
      expect(result!.database).toBeUndefined();
    });

    test("decodes URL-encoded credentials", () => {
      const result = parseConnectionString("https://user%40corp:p%40ss%23word@ch-host/demo");
      expect(result!.user).toBe("user@corp");
      expect(result!.password).toBe("p@ss#word");
    });

    test("returns null for a malformed ClickHouse URL", () => {
      expect(parseConnectionString("clickhouse://:::bad")).toBeNull();
      expect(parseConnectionString("http://:::bad")).toBeNull();
      expect(parseConnectionString("https://:::bad")).toBeNull();
    });
  });

  // ── Apache Druid: deliberately no scheme (issue #265) ───────────────────

  describe("Druid has no connection-string form", () => {
    // Druid's capabilities set supportsConnectionString: false and its UI config sets
    // showConnectionStringToggle: false, so nothing in the product ever produces or
    // consumes a Druid URI. There is no convention to parse either: Druid's own JDBC
    // driver addresses Avatica (jdbc:avatica:remote:url=http://host:8888/druid/v2/sql/avatica/),
    // which is not a URL this parser could round-trip into host/port/user/password.
    // These tests pin that absence so a future reader does not read it as an omission.
    test("does not invent a druid:// scheme", () => {
      expect(parseConnectionString("druid://localhost:8888")).toBeNull();
      expect(detectConnectionStringType("druid://localhost:8888")).toBeNull();
    });

    test("http:// and https:// stay ClickHouse, even on Druid's Router port", () => {
      // The consequence of the decision above, recorded rather than hidden: the generic
      // HTTP schemes were claimed by ClickHouse first (issue #264), so pasting a Druid
      // Router URL selects ClickHouse. A Druid connection is made through the form
      // fields instead, which is why its form has no paste toggle at all.
      expect(detectConnectionStringType("http://localhost:8888")).toBe("clickhouse");
      expect(parseConnectionString("http://localhost:8888")!.type).toBe("clickhouse");
    });
  });

  // ── Trino: deliberately no scheme (issue #424 Phase 2) ──────────────────

  describe("Trino has no connection-string form", () => {
    // Trino DOES have a canonical URL - `jdbc:trino://host:port/catalog/schema` - and
    // that is exactly why nothing was added here: it is a JDBC URL, not a URI this
    // parser's `new URL()` path can read, and stripping the `jdbc:` prefix to make it
    // one would invent a scheme no Trino tool emits. The provider's capabilities say
    // supportsConnectionString: false and its UI config says
    // showConnectionStringToggle: false, so nothing in the product produces one either.
    test("does not invent a trino:// scheme", () => {
      expect(parseConnectionString("trino://localhost:8080/tpch")).toBeNull();
      expect(detectConnectionStringType("trino://localhost:8080/tpch")).toBeNull();
    });

    test("does not read Trino's own JDBC URL", () => {
      expect(parseConnectionString("jdbc:trino://localhost:8080/tpch/sf1")).toBeNull();
      expect(detectConnectionStringType("jdbc:trino://localhost:8080/tpch/sf1")).toBeNull();
    });

    test("http:// and https:// stay ClickHouse, even on the coordinator port", () => {
      // Same consequence Druid records: the generic HTTP schemes were claimed by
      // ClickHouse first (issue #264), and two engines cannot own one scheme. A Trino
      // connection is made through the form fields, which is why its form has no paste
      // toggle at all.
      expect(detectConnectionStringType("http://localhost:8080")).toBe("clickhouse");
      expect(parseConnectionString("http://localhost:8080")!.type).toBe("clickhouse");
    });
  });

  // ── Cassandra: deliberately no scheme (issue #424 Phase 4) ──────────────

  describe("Cassandra has no connection-string form", () => {
    // The driver takes contact points plus a REQUIRED `localDataCenter`, and no URI
    // convention in use carries the second - so any `cassandra://` form this parser
    // read would drop the one field without which the driver refuses to connect. The
    // provider says supportsConnectionString: false and its UI config says
    // showConnectionStringToggle: false, so nothing in the product produces one either.
    test("does not invent a cassandra:// scheme", () => {
      expect(parseConnectionString("cassandra://localhost:9042/probe")).toBeNull();
      expect(detectConnectionStringType("cassandra://localhost:9042/probe")).toBeNull();
    });

    test("cassandra is absent from the published scheme map", () => {
      expect(ENGINE_URI_SCHEMES.cassandra).toBeUndefined();
    });
  });

  // ── ADO.NET format ──────────────────────────────────────────────────────

  describe("ADO.NET format", () => {
    test("parses full ADO.NET connection string", () => {
      const result = parseConnectionString("Server=myserver,1434;Database=mydb;User Id=sa;Password=secret;");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("mssql");
      expect(result!.host).toBe("myserver");
      expect(result!.port).toBe("1434");
      expect(result!.database).toBe("mydb");
      expect(result!.user).toBe("sa");
      expect(result!.password).toBe("secret");
    });

    test("uses default port when not specified in Server", () => {
      const result = parseConnectionString("Server=myserver;Database=mydb;");
      expect(result!.port).toBe("1433");
      expect(result!.host).toBe("myserver");
    });

    test("handles Initial Catalog and UID/PWD aliases", () => {
      const result = parseConnectionString("Server=host;Initial Catalog=testdb;UID=admin;PWD=pass123;");
      expect(result!.database).toBe("testdb");
      expect(result!.user).toBe("admin");
      expect(result!.password).toBe("pass123");
    });

    test("strips the tcp: protocol prefix the Azure portal writes in Server", () => {
      const result = parseConnectionString(
        "Server=tcp:myserver.database.windows.net,1433;Initial Catalog=mydb;Persist Security Info=False;User ID=myuser;Password=secret;MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;",
      );
      expect(result!.host).toBe("myserver.database.windows.net");
      expect(result!.port).toBe("1433");
      expect(result!.database).toBe("mydb");
      expect(result!.user).toBe("myuser");
      expect(result!.sslMode).toBe("verify-full");
    });

    test("strips the tcp: prefix case-insensitively and without a port", () => {
      const result = parseConnectionString("Server=TCP:myserver;Database=mydb;");
      expect(result!.host).toBe("myserver");
      expect(result!.port).toBe("1433");
    });

    test("keeps a host that only starts with the letters tcp", () => {
      expect(parseConnectionString("Server=tcp-gateway,1433;")!.host).toBe("tcp-gateway");
    });

    test("reports a named-pipes server instead of writing it into host", () => {
      const result = parseConnectionString("Server=np:myserver;Database=mydb;User Id=sa;");
      expect(result!.host).toBeUndefined();
      expect(result!.port).toBeUndefined();
      expect(result!.unsupportedServerProtocol).toBe("np");
      expect(result!.database).toBe("mydb");
      expect(result!.user).toBe("sa");
    });

    test("reports a shared-memory server, keeping the prefix as it was pasted", () => {
      const result = parseConnectionString("Server=LPC:myserver;");
      expect(result!.host).toBeUndefined();
      expect(result!.unsupportedServerProtocol).toBe("LPC");
    });

    test("handles Data Source alias", () => {
      const result = parseConnectionString("Data Source=db-host,1450;Database=app;");
      // "Data Source=..." starts with "Data", not "Server", so it won't match /^Server\s*=/i
      // Let's check — the regex is /^Server\s*=/i — Data Source won't match.
      // So this should return null.
      expect(result).toBeNull();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("returns null for empty string", () => {
      expect(parseConnectionString("")).toBeNull();
    });

    test("returns null for whitespace only", () => {
      expect(parseConnectionString("   ")).toBeNull();
    });

    test("returns null for unknown protocol", () => {
      expect(parseConnectionString("ftp://host/path")).toBeNull();
    });

    test("returns null for plain text", () => {
      expect(parseConnectionString("just some random text")).toBeNull();
    });

    test("trims whitespace before parsing", () => {
      const result = parseConnectionString("  postgres://user:pass@host/db  ");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("postgres");
    });

    test("handles URL with special characters in password", () => {
      const result = parseConnectionString("mysql://root:%23pass%25word@host/db");
      expect(result!.password).toBe("#pass%word");
    });
  });
});

// ─── detectConnectionStringType ─────────────────────────────────────────────

describe("detectConnectionStringType", () => {
  test("detects db2://", () => {
    expect(detectConnectionStringType("db2://host")).toBe("db2");
  });

  test("detects postgres://", () => {
    expect(detectConnectionStringType("postgres://host")).toBe("postgres");
  });

  test("detects postgresql://", () => {
    expect(detectConnectionStringType("postgresql://host")).toBe("postgres");
  });

  test("detects mysql://", () => {
    expect(detectConnectionStringType("mysql://host")).toBe("mysql");
  });

  test("detects mongodb://", () => {
    expect(detectConnectionStringType("mongodb://host")).toBe("mongodb");
  });

  test("detects mongodb+srv://", () => {
    expect(detectConnectionStringType("mongodb+srv://host")).toBe("mongodb");
  });

  test("detects redis://", () => {
    expect(detectConnectionStringType("redis://host")).toBe("redis");
  });

  test("detects rediss://", () => {
    expect(detectConnectionStringType("rediss://host")).toBe("redis");
  });

  test("detects oracle://", () => {
    expect(detectConnectionStringType("oracle://host")).toBe("oracle");
  });

  test("detects mssql://", () => {
    expect(detectConnectionStringType("mssql://host")).toBe("mssql");
  });

  test("detects sqlserver://", () => {
    expect(detectConnectionStringType("sqlserver://host")).toBe("mssql");
  });

  test("detects couchbase://", () => {
    expect(detectConnectionStringType("couchbase://host")).toBe("couchbase");
  });

  test("detects couchbases://", () => {
    expect(detectConnectionStringType("couchbases://cb.abc123.cloud.couchbase.com")).toBe("couchbase");
  });

  test("detects clickhouse://", () => {
    expect(detectConnectionStringType("clickhouse://host")).toBe("clickhouse");
  });

  test("detects a bare http:// and https:// endpoint as clickhouse", () => {
    // ClickHouse is the only provider addressed over plain HTTP, so the generic
    // schemes are unambiguous.
    expect(detectConnectionStringType("http://host:8123/demo")).toBe("clickhouse");
    expect(detectConnectionStringType("https://ch.example.clickhouse.cloud")).toBe("clickhouse");
  });

  test("detects ADO.NET Server= format", () => {
    expect(detectConnectionStringType("Server=host;Database=db;")).toBe("mssql");
  });

  test("returns null for unknown protocol", () => {
    expect(detectConnectionStringType("ftp://host")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(detectConnectionStringType("")).toBeNull();
  });

  test("is case insensitive", () => {
    expect(detectConnectionStringType("POSTGRES://host")).toBe("postgres");
    expect(detectConnectionStringType("MySQL://host")).toBe("mysql");
    expect(detectConnectionStringType("SERVER=host;")).toBe("mssql");
  });

  test("trims whitespace before detecting", () => {
    expect(detectConnectionStringType("  postgres://host  ")).toBe("postgres");
  });

  test("returns null for whitespace-only input", () => {
    expect(detectConnectionStringType("   ")).toBeNull();
  });
});

// ─── Additional MongoDB edge cases ──────────────────────────────────────────

describe("parseConnectionString: MongoDB edge cases", () => {
  test("MongoDB URL with username only (no password)", () => {
    const result = parseConnectionString("mongodb://admin@localhost:27017/mydb");
    expect(result).not.toBeNull();
    expect(result!.user).toBe("admin");
    expect(result!.password).toBeUndefined();
    expect(result!.database).toBe("mydb");
  });

  test("MongoDB+SRV without database path", () => {
    const result = parseConnectionString("mongodb+srv://user:pass@cluster.example.com");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("mongodb");
    expect(result!.user).toBe("user");
    expect(result!.database).toBeUndefined();
  });

  test("MongoDB replica set URL (multiple hosts — takes first)", () => {
    const uri = "mongodb://user:pass@host1:27017,host2:27018,host3:27019/mydb?replicaSet=rs0";
    const result = parseConnectionString(uri);
    expect(result!.host).toBe("host1");
    expect(result!.port).toBe("27017");
    expect(result!.database).toBe("mydb");
  });

  test("MongoDB encoded database name", () => {
    const result = parseConnectionString("mongodb://user:pass@host:27017/my%20db");
    expect(result!.database).toBe("my db");
  });

  test("MongoDB with no slash after host (no database path)", () => {
    const result = parseConnectionString("mongodb://localhost:27017");
    expect(result!.type).toBe("mongodb");
    expect(result!.database).toBeUndefined();
    expect(result!.host).toBeUndefined();
  });
});

// ─── Additional generic URL edge cases ──────────────────────────────────────

describe("parseConnectionString: generic URL edge cases", () => {
  test("malformed generic URL triggers catch block and returns null", () => {
    // Invalid URL that will throw in new URL()
    const result = parseConnectionString("postgres://:::invalid");
    expect(result).toBeNull();
  });

  test("malformed MSSQL URL triggers catch block and returns null", () => {
    const result = parseConnectionString("mssql://:::bad");
    expect(result).toBeNull();
  });
});

// ─── Additional ADO.NET edge cases ──────────────────────────────────────────

describe("parseConnectionString: ADO.NET edge cases", () => {
  test("ADO.NET with trailing semicolons and empty parts", () => {
    const result = parseConnectionString("Server=host;Database=db;;;");
    expect(result).not.toBeNull();
    expect(result!.host).toBe("host");
    expect(result!.database).toBe("db");
  });

  test("ADO.NET with no user/password", () => {
    const result = parseConnectionString("Server=myhost;Database=testdb;");
    expect(result).not.toBeNull();
    expect(result!.user).toBeUndefined();
    expect(result!.password).toBeUndefined();
    expect(result!.database).toBe("testdb");
  });

  test("returns null when ADO.NET parsing throws (defensive catch)", () => {
    // The ADO.NET parser only performs string operations, so its defensive
    // catch is unreachable with plain strings. Force the internal `split(";")`
    // to throw for the duration of this synchronous call to exercise it.
    const originalSplit = String.prototype.split;
    // eslint-disable-next-line no-extend-native
    String.prototype.split = function (this: string, separator: unknown, limit?: number) {
      if (separator === ";") throw new Error("simulated split failure");
      return originalSplit.call(this, separator as never, limit);
    } as typeof String.prototype.split;
    try {
      expect(parseConnectionString("Server=host;Database=db;")).toBeNull();
    } finally {
      // eslint-disable-next-line no-extend-native
      String.prototype.split = originalSplit;
    }
  });
});

// ─── TLS carried in the query string / ADO.NET keywords ─────────────────────

// Measured 2026-08-25 against the live engines, and the two measurements are why the
// opportunistic values below are refused rather than mapped:
//   postgres 18, no server certificate:
//     ?sslmode=prefer  -> connects, pg_stat_ssl.ssl = f  (plaintext, and it works)
//     ?sslmode=require -> "server does not support SSL, but SSL was required"
//   mysql over TCP, default self-signed certificate:
//     --ssl-mode=PREFERRED -> Ssl_cipher TLS_AES_128_GCM_SHA256 (encrypted)
//     --ssl-mode=DISABLED  -> Ssl_cipher empty (plaintext)
// So "prefer" onto `require` breaks a working Postgres connection, and "PREFERRED"
// onto `disable` silently downgrades a MySQL connection that was encrypted.

describe("parseConnectionString: TLS parameters", () => {
  describe("postgres sslmode", () => {
    const mapped: Array<[string, SSLMode]> = [
      ["disable", "disable"],
      ["require", "require"],
      ["verify-ca", "verify-ca"],
      ["verify-full", "verify-full"],
      ["VERIFY-FULL", "verify-full"],
      ["Require", "require"],
    ];
    for (const [value, expected] of mapped) {
      test(`maps sslmode=${value} to ${expected}`, () => {
        const result = parseConnectionString(`postgresql://u:p@host/db?sslmode=${value}`);
        expect(result!.sslMode).toBe(expected);
        expect(result!.unmappedTLSParam).toBeUndefined();
        expect(result!.database).toBe("db");
      });
    }

    for (const value of ["prefer", "allow", "PREFER"]) {
      test(`refuses to map the opportunistic sslmode=${value}`, () => {
        const result = parseConnectionString(`postgres://u:p@host/db?sslmode=${value}`);
        expect(result!.sslMode).toBeUndefined();
        expect(result!.unmappedTLSParam).toBe(`sslmode=${value}`);
      });
    }

    // `verify-system` is OUR form's mode, not a libpq one: libpq's sslmode has no such
    // value, so a string carrying it is a string we cannot honour and must report.
    test("the form's own verify-system is not a libpq sslmode", () => {
      const result = parseConnectionString("postgres://u:p@host/db?sslmode=verify-system");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("sslmode=verify-system");
    });

    test("an unrecognised sslmode does not become disable", () => {
      const result = parseConnectionString("postgres://u:p@host/db?sslmode=banana");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("sslmode=banana");
    });

    // The map is a plain object literal, so an all-lowercase Object.prototype key reaches
    // the lookup: `sslmode=constructor` resolved to the Object CONSTRUCTOR FUNCTION, which
    // is truthy, so it was written into ParsedConnection.sslMode and set as the form's
    // SSLMode - a non-SSLMode value smuggled past the very banner this refusal exists to
    // raise. `toString`/`valueOf` do not reach it only because the lookup lower-cases.
    test("an inherited Object.prototype key is refused, not resolved", () => {
      const result = parseConnectionString("postgres://u:p@host/db?sslmode=constructor");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("sslmode=constructor");
    });

    // D26: `pg` reads `ssl=true` as TLS with Node's default `rejectUnauthorized: true`, so
    // the mapping has to be the verifying mode that needs no PEM. It used to be `require`,
    // which is `rejectUnauthorized: false` here - encrypted, chain unchecked - i.e. a paste
    // that asked for verification silently got none.
    test("maps the JDBC/Heroku ssl=true form to verify-system, not to require", () => {
      expect(parseConnectionString("postgres://u:p@host/db?ssl=true")!.sslMode).toBe("verify-system");
      expect(parseConnectionString("postgres://u:p@host/db?ssl=1")!.sslMode).toBe("verify-system");
      expect(parseConnectionString("postgres://u:p@host/db?ssl=false")!.sslMode).toBe("disable");
      expect(parseConnectionString("postgres://u:p@host/db?ssl=0")!.sslMode).toBe("disable");
    });

    test("an unrecognised ssl value does not become disable", () => {
      const result = parseConnectionString("postgres://u:p@host/db?ssl=maybe");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("ssl=maybe");
    });

    // The banner quotes the parameter back at the user, so it must be the spelling they
    // pasted: the lookup is case-insensitive but the echo is not normalised.
    test("reports the parameter in the case it was written", () => {
      expect(parseConnectionString("postgres://u:p@host/db?SSLMode=prefer")!.unmappedTLSParam).toBe("SSLMode=prefer");
    });

    test("sslmode wins over ssl when both are present", () => {
      const result = parseConnectionString("postgres://u:p@host/db?ssl=true&sslmode=verify-full");
      expect(result!.sslMode).toBe("verify-full");
    });

    test("says nothing about TLS when the string carries no TLS parameter", () => {
      const result = parseConnectionString("postgres://u:p@host/db?application_name=studio");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBeUndefined();
    });

    // sslrootcert/sslcert/sslkey are client-side FILE PATHS; the form holds PEM text and
    // the server that opens the connection is not the machine the path refers to.
    test("ignores sslrootcert, which names a file this form cannot read", () => {
      const result = parseConnectionString("postgres://u:p@host/db?sslmode=verify-ca&sslrootcert=/etc/ca.pem");
      expect(result!.sslMode).toBe("verify-ca");
      expect(result!.unmappedTLSParam).toBeUndefined();
    });
  });

  describe("mysql ssl-mode", () => {
    const mapped: Array<[string, SSLMode]> = [
      ["DISABLED", "disable"],
      ["REQUIRED", "require"],
      ["VERIFY_CA", "verify-ca"],
      ["VERIFY_IDENTITY", "verify-full"],
      ["required", "require"],
    ];
    for (const [value, expected] of mapped) {
      test(`maps ssl-mode=${value} to ${expected}`, () => {
        const result = parseConnectionString(`mysql://root:pw@host:3306/app?ssl-mode=${value}`);
        expect(result!.sslMode).toBe(expected);
      });
    }

    test("accepts the sslmode spelling too", () => {
      expect(parseConnectionString("mysql://root:pw@host/app?sslmode=REQUIRED")!.sslMode).toBe("require");
    });

    test("refuses to map ssl-mode=PREFERRED", () => {
      const result = parseConnectionString("mysql://root:pw@host/app?ssl-mode=PREFERRED");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("ssl-mode=PREFERRED");
    });

    test("an unrecognised ssl-mode does not become disable", () => {
      const result = parseConnectionString("mysql://root:pw@host/app?ssl-mode=SOMETHING");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("ssl-mode=SOMETHING");
    });

    // `ssl` and `useSSL` are the boolean spellings the JDBC connector and several ORMs
    // write. Reading only ssl-mode dropped them with no mode AND no banner, which is the
    // silent-downgrade defect this whole parameter exists to prevent.
    test("maps the boolean ssl=true / useSSL=true forms to verify-system", () => {
      expect(parseConnectionString("mysql://u:p@host/db?ssl=true")!.sslMode).toBe("verify-system");
      expect(parseConnectionString("mysql://u:p@host/db?ssl=1")!.sslMode).toBe("verify-system");
      expect(parseConnectionString("mysql://u:p@host/db?useSSL=true")!.sslMode).toBe("verify-system");
      expect(parseConnectionString("mysql://u:p@host/db?useSSL=TRUE")!.sslMode).toBe("verify-system");
    });

    test("maps the boolean ssl=false / useSSL=false forms to disable", () => {
      expect(parseConnectionString("mysql://u:p@host/db?ssl=false")!.sslMode).toBe("disable");
      expect(parseConnectionString("mysql://u:p@host/db?ssl=0")!.sslMode).toBe("disable");
      expect(parseConnectionString("mysql://u:p@host/db?useSSL=false")!.sslMode).toBe("disable");
    });

    test("the form's own verify-system is not a MySQL ssl-mode", () => {
      const result = parseConnectionString("mysql://u:p@host/db?ssl-mode=verify-system");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("ssl-mode=verify-system");
    });

    test("an unrecognised boolean value is reported verbatim, in the spelling that was pasted", () => {
      const result = parseConnectionString("mysql://u:p@host/db?useSSL=maybe");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("useSSL=maybe");
    });

    test("ssl-mode wins over the boolean spellings when both are present", () => {
      expect(parseConnectionString("mysql://u:p@host/db?ssl=false&ssl-mode=REQUIRED")!.sslMode).toBe("require");
    });

    test("mysql2's object form of ssl is reported rather than read as a boolean", () => {
      const result = parseConnectionString('mysql://u:p@host/db?ssl={"rejectUnauthorized":true}');
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe('ssl={"rejectUnauthorized":true}');
    });
  });

  describe("SQL Server Encrypt / TrustServerCertificate", () => {
    test("Encrypt=True with TrustServerCertificate=True is require", () => {
      const result = parseConnectionString("Server=sql,1433;Database=db;Encrypt=True;TrustServerCertificate=True;");
      expect(result!.type).toBe("mssql");
      expect(result!.sslMode).toBe("require");
    });

    test("Encrypt=True without TrustServerCertificate validates the chain and the name", () => {
      const result = parseConnectionString("Server=sql;Database=db;Encrypt=True;");
      expect(result!.sslMode).toBe("verify-full");
    });

    test("Encrypt=yes with TrustServerCertificate=false is verify-full", () => {
      const result = parseConnectionString("Server=sql;Encrypt=yes;TrustServerCertificate=no;");
      expect(result!.sslMode).toBe("verify-full");
    });

    test("Encrypt=Strict is verify-full", () => {
      expect(parseConnectionString("Server=sql;Encrypt=Strict;")!.sslMode).toBe("verify-full");
    });

    test("Encrypt=False is disable", () => {
      expect(parseConnectionString("Server=sql;Encrypt=False;")!.sslMode).toBe("disable");
      expect(parseConnectionString("Server=sql;Encrypt=no;")!.sslMode).toBe("disable");
    });

    test("an absent Encrypt says nothing: the two .NET drivers default it differently", () => {
      const result = parseConnectionString("Server=sql;Database=db;User Id=sa;Password=pw;");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBeUndefined();
    });

    test("an unrecognised Encrypt does not become disable", () => {
      const result = parseConnectionString("Server=sql;Encrypt=Maybe;");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("Encrypt=Maybe");
    });

    test("an unrecognised TrustServerCertificate is reported rather than guessed", () => {
      const result = parseConnectionString("Server=sql;Encrypt=True;TrustServerCertificate=Sometimes;");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("TrustServerCertificate=Sometimes");
    });

    test("the mssql:// URL form carries the same keywords", () => {
      const result = parseConnectionString("mssql://sa:pw@host:1433/db?encrypt=true&trustServerCertificate=true");
      expect(result!.sslMode).toBe("require");
      expect(result!.database).toBe("db");
    });

    test("sqlserver:// with encrypt=false is disable", () => {
      expect(parseConnectionString("sqlserver://sa:pw@host/db?encrypt=false")!.sslMode).toBe("disable");
    });
  });

  describe("engines whose scheme already decides", () => {
    test("a rediss:// query string does not override the scheme's require", () => {
      expect(parseConnectionString("rediss://host:6379?sslmode=disable")!.sslMode).toBe("require");
    });

    test("an https:// ClickHouse URL keeps require", () => {
      expect(parseConnectionString("https://host/default?sslmode=prefer")!.sslMode).toBe("require");
    });

    // D26: the driver reads `tls=true` as TLS WITH chain verification, and `verify-system`
    // is the mode that says exactly that, so the paste is now described instead of ignored.
    // While `require` was the only non-disable mode this had to stay unset: setting it would
    // have handed the driver rejectUnauthorized:false and stopped an Atlas certificate being
    // checked.
    test("mongodb tls=true maps onto the verifying mode the driver already applies", () => {
      const result = parseConnectionString("mongodb://u:p@host:27017/db?tls=true");
      expect(result!.sslMode).toBe("verify-system");
      expect(result!.unmappedTLSParam).toBeUndefined();
    });

    test("mongodb ssl=true, the driver's own deprecated alias, maps the same way", () => {
      expect(parseConnectionString("mongodb://u:p@host:27017/db?ssl=true")!.sslMode).toBe("verify-system");
    });

    test("mongodb tls=false is explicit plaintext", () => {
      expect(parseConnectionString("mongodb://u:p@host:27017/db?tls=false")!.sslMode).toBe("disable");
    });

    // The driver's own relaxing options (`tlsInsecure`, `tlsAllowInvalidCertificates`) turn
    // `rejectUnauthorized` OFF while leaving TLS on, which is precisely `require`. Reading
    // `tls=true` on its own here would have set the verifying mode and, because the provider
    // passes the options object as a second channel the driver prefers over the URI, broken a
    // string that connects today.
    test("a relaxing tls option keeps the paste on require, not on the verifying mode", () => {
      expect(parseConnectionString("mongodb://h:27017/db?tls=true&tlsInsecure=true")!.sslMode).toBe("require");
      expect(parseConnectionString("mongodb://h:27017/db?tls=true&tlsAllowInvalidCertificates=true")!.sslMode).toBe(
        "require",
      );
      expect(parseConnectionString("mongodb+srv://h/db?tlsAllowInvalidCertificates=true")!.sslMode).toBe("require");
    });

    test("a relaxing option that is off does not weaken the mode", () => {
      expect(parseConnectionString("mongodb://h:27017/db?tls=true&tlsInsecure=false")!.sslMode).toBe("verify-system");
    });

    test("a relaxing option cannot turn plaintext into TLS", () => {
      expect(parseConnectionString("mongodb://h:27017/db?tlsInsecure=true")!.sslMode).toBeUndefined();
      expect(parseConnectionString("mongodb://h:27017/db?tls=false&tlsInsecure=true")!.sslMode).toBe("disable");
    });

    test("a non-boolean tls value is reported rather than guessed at", () => {
      const result = parseConnectionString("mongodb://u:p@host:27017/db?tls=maybe");
      expect(result!.sslMode).toBeUndefined();
      expect(result!.unmappedTLSParam).toBe("tls=maybe");
    });
  });
});

// ─── databend:// DSNs (Databend design 6.2) ─────────────────────────────────

describe("parseConnectionString: databend:// DSNs", () => {
  test("a Databend Cloud DSN fills every field, with TLS verified and the warehouse", () => {
    const result = parseConnectionString(
      "databend://cloudapp:p%40ss@tn3ftqihs.gw.aws-us-east-2.default.databend.com:443/default?warehouse=small-xy2t",
    );
    expect(result).toEqual({
      type: "databend",
      host: "tn3ftqihs.gw.aws-us-east-2.default.databend.com",
      port: "443",
      user: "cloudapp",
      password: "p@ss",
      database: "default",
      warehouse: "small-xy2t",
      sslMode: "verify-system",
      allowInsecureAuth: false,
    });
  });

  test("a DSN gives no consent to a password without TLS, so every Databend paste clears it", () => {
    for (const dsn of [
      "databend://u:p@host/db",
      "databend+http://u:p@host:8000/db",
      "databend+https://u:p@host/db?sslmode=disable",
      "databend://u:p@host/db?sslmode=verify-full",
    ]) {
      expect(parseConnectionString(dsn)!.allowInsecureAuth, dsn).toBe(false);
    }
    // Db2's form shares the box, and a db2:// paste says nothing of it, so it leaves it as it was.
    expect(parseConnectionString("db2://u:p@host:50000/db")).not.toHaveProperty("allowInsecureAuth");
    // A refusal fills nothing.
    expect(parseConnectionString("databend://u:p@host/db#x")).not.toHaveProperty("allowInsecureAuth");
  });

  test("TLS is on unless sslmode=disable, as BendSQL reads the DSN", () => {
    expect(parseConnectionString("databend://root:@localhost:8000/default")!.sslMode).toBe("verify-system");
    const plain = parseConnectionString("databend://root:@localhost:8000/?sslmode=disable")!;
    expect(plain.sslMode).toBe("disable");
    expect(plain.port).toBe("8000");
    expect(plain.user).toBe("root");
    expect(plain.password).toBeUndefined();
    expect(plain.database).toBeUndefined();
  });

  test("databend+http:// is plaintext and databend+https:// is TLS", () => {
    const http = parseConnectionString("databend+http://root:@localhost:8000/default")!;
    expect(http.type).toBe("databend");
    expect(http.sslMode).toBe("disable");
    expect(http.port).toBe("8000");
    expect(parseConnectionString("databend+https://root:@db.example.com/default")!.sslMode).toBe("verify-system");
  });

  test("a DSN without a port gets 443 with TLS and 80 without, never the form's 8000", () => {
    expect(getDBConfig("databend").defaultPort).toBe("8000");
    expect(parseConnectionString("databend://u:p@host/db")!.port).toBe("443");
    expect(parseConnectionString("databend+https://u:p@host/db")!.port).toBe("443");
    expect(parseConnectionString("databend://u:p@host/db?sslmode=disable")!.port).toBe("80");
    expect(parseConnectionString("databend+http://u:p@host/db")!.port).toBe("80");
  });

  test("an empty host reads as localhost", () => {
    expect(parseConnectionString("databend:///db?sslmode=disable")!.host).toBe("localhost");
  });

  test("user and password are percent-decoded, and a broken escape is kept as written", () => {
    const result = parseConnectionString("databend://us%40er:p%3Aw%2Fd@host/db")!;
    expect(result.user).toBe("us@er");
    expect(result.password).toBe("p:w/d");
    expect(parseConnectionString("databend://u:100%25%zz@host/db")!.password).toBe("100%25%zz");
  });

  test("the database path is percent-decoded, and a broken escape is kept as written", () => {
    expect(parseConnectionString("databend://u:p@host/my%20db")!.database).toBe("my db");
    expect(parseConnectionString("databend://u:p@host/caf%C3%A9")!.database).toBe("café");
    expect(parseConnectionString("databend://u:p@host/%E5%9C%A8")!.database).toBe("在");
    expect(parseConnectionString("databend://u:p@host/my%ZZdb")!.database).toBe("my%ZZdb");
  });

  test("a # anywhere is refused, because it ends the URL", () => {
    const result = parseConnectionString("databend://root:pa#ss@host:443/db");
    expect(result).toEqual({ type: "databend", refusal: DATABEND_DSN_REFUSALS.fragment });
    expect(DATABEND_DSN_REFUSALS.fragment).toBe(
      "The DSN contains #, which ends a URL: percent-encode it as %23, or type the password in its own field.",
    );
  });

  test.each([
    "databend://cloudapp:2024/Secret-Tail@tenant.gw.aws-us-east-2.default.databend.com:443/default?warehouse=w1",
    "databend://cloudapp:2024?Secret-Tail@tenant.gw.aws-us-east-2.default.databend.com:443/default",
    "databend://cloudapp:/Secret-Tail@tenant.gw.aws-us-east-2.default.databend.com:443/default",
    "databend://cloudapp:Secret/Tail@tenant.gw.aws-us-east-2.default.databend.com:443/default",
    "databend://cloudapp:Secret?Tail@tenant.gw.aws-us-east-2.default.databend.com:443/default",
    "databend://cloud/app:Secret-Tail@tenant.gw.aws-us-east-2.default.databend.com:443/default",
  ])(
    "a / or ? before the sign-in's @ is refused, since the URL parser would read the rest as the path: %s",
    (input) => {
      const result = parseConnectionString(input);
      expect(result).toEqual({ type: "databend", refusal: DATABEND_DSN_REFUSALS.userinfo });
      expect(JSON.stringify(result)).not.toContain("Tail");
    },
  );

  // The same text is the other reading when the @ is the path's or a parameter's, so the sentence names both.
  test.each([
    "databend://db.example.com:8000/default?role=analyst@corp",
    "databend://db.example.com:8000/default?tls_ca_file=/home/jane@corp.example/ca.pem",
    "databend://db.example.com:8000/team@corp",
  ])("an @ past the address part of a DSN with no sign-in is refused, naming both readings: %s", (input) => {
    expect(parseConnectionString(input)).toEqual({ type: "databend", refusal: DATABEND_DSN_REFUSALS.userinfo });
    expect(DATABEND_DSN_REFUSALS.userinfo).toBe(
      "The DSN has an @ after a / or ?, which end the address part of a URL: percent-encode a /, ? or @ in the user or password as %2F, %3F or %40, or type the password in its own field, and an @ in the path or a parameter as %40.",
    );
  });

  // A password may hold an unencoded @ before its / or ?, so an @ in the address part does not settle which @ signs in:
  // `root:p@ss/x@host` would read host `ss` and put the rest of the password in Database.
  test.each([
    "databend://root:p@ss/x@db.example.com:8000/default",
    "databend://root:p@ss?x@db.example.com:8000/default",
    "databend://root:pw@db.example.com:8000/default?role=analyst@corp",
    "databend://root@db.example.com:8000/default?tls_ca_file=/home/jane@corp.example/ca.pem",
    "databend://root@db.example.com:8000/team@corp",
  ])("an @ past the address part is refused even when the address part holds one: %s", (input) => {
    const result = parseConnectionString(input);
    expect(result).toEqual({ type: "databend", refusal: DATABEND_DSN_REFUSALS.userinfo });
    expect(JSON.stringify(result)).not.toContain("ss/x");
  });

  test("percent-encoded, an @ of the password, the path or a parameter reads one way only", () => {
    const password = parseConnectionString("databend://root:p%40ss%2Fx@db.example.com:8000/default")!;
    expect([password.user, password.password, password.host, password.database]).toEqual([
      "root",
      "p@ss/x",
      "db.example.com",
      "default",
    ]);
    const role = parseConnectionString("databend://root:pw@db.example.com:8000/default?role=analyst%40corp")!;
    expect(role.refusal).toBeUndefined();
    expect(role.ignoredParameters).toEqual(["role"]);
    expect(parseConnectionString("databend://root@db.example.com:8000/team%40corp")!.refusal).toBeUndefined();
    const encoded = parseConnectionString("databend://db.example.com:8000/default?role=analyst%40corp")!;
    expect(encoded.refusal).toBeUndefined();
    expect(encoded.ignoredParameters).toEqual(["role"]);
  });

  test("a percent-encoded / or ? in the sign-in, and an @ only before the path, still parse", () => {
    const encoded = parseConnectionString("databend://cloudapp:2024%2FSecret%3FTail@host:443/default?warehouse=w1")!;
    expect([encoded.user, encoded.password, encoded.host, encoded.database]).toEqual([
      "cloudapp",
      "2024/Secret?Tail",
      "host",
      "default",
    ]);
    expect(parseConnectionString("databend://root@host:8000/default?sslmode=disable")!.refusal).toBeUndefined();
    expect(parseConnectionString("databend:///default?sslmode=disable")!.refusal).toBeUndefined();
  });

  test("tls_ca_file is not applied: a caution says Studio reads no CA path and where the certificate goes", () => {
    const result = parseConnectionString("databend://u:p@host/db?tls_ca_file=/etc/databend/ca.pem")!;
    expect(result.cautions).toEqual([DATABEND_DSN_CAUTIONS.caFile]);
    expect(result.tlsFileParam).toBeUndefined();
    expect(result.ignoredParameters).toBeUndefined();
    expect(result.sslMode).toBe("verify-system");
    // Named, never valued: the path stays in the parser.
    expect(JSON.stringify(result)).not.toContain("/etc/databend/ca.pem");
    expect(DATABEND_DSN_CAUTIONS.caFile).toBe(
      "Studio reads no CA file path from a DSN, so tls_ca_file was not applied: paste the certificate's contents into the CA field under SSL / TLS.",
    );
  });

  test("an sslmode BendSQL does not read gets Databend's own caution, not the form's TLS sentence", () => {
    const result = parseConnectionString("databend://u:p@host/db?sslmode=verify-full")!;
    expect(result.cautions).toEqual([DATABEND_DSN_CAUTIONS.sslmode("verify-full")]);
    expect(result.unmappedTLSParam).toBeUndefined();
    expect(result.sslMode).toBeUndefined();
    expect(DATABEND_DSN_CAUTIONS.sslmode("verify-full")).toBe(
      "sslmode=verify-full is not a Databend DSN mode (BendSQL reads disable, require and enable), so SSL mode was left as it was: choose one under SSL / TLS.",
    );
    const both = parseConnectionString("databend://u:p@host/db?sslmode=verify-ca&tls_ca_file=/ca.pem")!;
    expect(both.cautions).toEqual([DATABEND_DSN_CAUTIONS.sslmode("verify-ca"), DATABEND_DSN_CAUTIONS.caFile]);
    expect(parseConnectionString("databend://u:p@host/db?sslmode=require")!.cautions).toBeUndefined();
  });

  test.each([
    ["tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com", "eric"],
    ["tnf34b0rm--elt-wh-medium.gw.aliyun-cn-beijing.default.databend.cn", "elt-wh-medium"],
    ["Tenant--MyWH.GW.aws-us-east-2.default.Databend.COM.", "MyWH"],
  ])("an older Databend Cloud host, %s, fills Warehouse from the host when the DSN has no warehouse=", (host, name) => {
    const result = parseConnectionString(`databend://cloudapp@${host}:443/default`)!;
    expect(result.host).toBe(host);
    expect(result.warehouse).toBe(name);
    expect(result.ignoredParameters).toBeUndefined();
  });

  test("warehouse= wins over the host's, and a host that is not an older Cloud host fills no Warehouse", () => {
    const named = "databend://cloudapp@tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com:443/default";
    expect(parseConnectionString(`${named}?warehouse=small-xy2t`)!.warehouse).toBe("small-xy2t");
    expect(parseConnectionString(`${named}?warehouse=`)!.warehouse).toBe("eric");
    for (const host of [
      "tn3ftqihs.gw.aws-us-east-2.default.databend.com",
      "tn3ftqihs--eric.ch.aws-us-east-2.default.databend.com",
      "--eric.gw.aws-us-east-2.default.databend.com",
      "tn3ftqihs--.gw.aws-us-east-2.default.databend.com",
      "tn3ftqihs--e_ric.gw.aws-us-east-2.default.databend.com",
      "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com.example.net",
      "db--internal.example.com",
      // Counted as Databend Cloud's for billing, but the older form is shown under databend.com and databend.cn only.
      "tn3ftqihs--eric.gw.aws-us-east-2.default.tidbcloud.com",
    ]) {
      expect(parseConnectionString(`databend://cloudapp@${host}:443/default`)!.warehouse, host).toBeUndefined();
    }
  });

  test("sslmode=require and sslmode=enable verify the certificate, with a notice saying so (X34)", () => {
    const required = parseConnectionString("databend://u:p@host/db?sslmode=require")!;
    expect(required.sslMode).toBe("verify-system");
    expect(required.notice).toBe(DATABEND_SSLMODE_NOTICES.require);
    expect(DATABEND_SSLMODE_NOTICES.require).toBe(
      "sslmode=require in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system.",
    );
    const enabled = parseConnectionString("databend://u:p@host/db?sslmode=enable")!;
    expect(enabled.sslMode).toBe("verify-system");
    expect(enabled.notice).toBe(DATABEND_SSLMODE_NOTICES.enable);
    expect(parseConnectionString("databend://u:p@host/db")!.notice).toBeUndefined();
    expect(parseConnectionString("databend://u:p@host/db?sslmode=disable")!.notice).toBeUndefined();
  });

  test("an sslmode BendSQL refuses sets no mode and is reported, with the port the scheme's: 80 for +http, else 443", () => {
    const result = parseConnectionString("databend://u:p@host/db?sslmode=verify-full")!;
    expect(result.sslMode).toBeUndefined();
    expect(result.cautions).toEqual([DATABEND_DSN_CAUTIONS.sslmode("verify-full")]);
    expect(result.port).toBe("443");
    const plain = parseConnectionString("databend+http://u:p@host/db?sslmode=verify-full")!;
    expect(plain.sslMode).toBeUndefined();
    expect(plain.cautions).toEqual([DATABEND_DSN_CAUTIONS.sslmode("verify-full")]);
    expect(plain.port).toBe("80");
    expect(parseConnectionString("databend+https://u:p@host/db?sslmode=verify-full")!.port).toBe("443");
    // The DSN's own port wins over either default.
    expect(parseConnectionString("databend+http://u:p@host:8000/db?sslmode=verify-full")!.port).toBe("8000");
  });

  test("BendSQL's own parameters are named once each, in order, and never valued; any other is counted", () => {
    const result = parseConnectionString(
      "databend://u:p@host/db?role=analyst_secret&enable_dphyp=1&warehouse=w1&tenant=t9&role=again&sslmode=disable",
    )!;
    expect(result.ignoredParameters).toEqual(["role", "tenant"]);
    expect(result.unnamedParameters).toBe(1);
    expect(result.warehouse).toBe("w1");
    const text = JSON.stringify(result);
    for (const value of ["analyst_secret", "again", "t9", "enable_dphyp"]) expect(text).not.toContain(value);
    const plain = parseConnectionString("databend://u:p@host/db?warehouse=w1")!;
    expect(plain.ignoredParameters).toBeUndefined();
    expect(plain.unnamedParameters).toBeUndefined();
  });

  test.each([
    // An unencoded & inside the password parameter's value: the rest of the value reads as a name of its own.
    ["password=SENTINELA&SENTINELB", 2],
    // A bare token, with no name=, is no parameter BendSQL names.
    ["warehouse=w&SENTINELBARETOKEN", 1],
    // A recognised name with no =, which can be the tail of a value split at an &, is counted too.
    ["role", 1],
    ["x=1&x=2&&SENTINELC", 2],
  ])("a paste of %s names nothing from it and counts %d", (query, count) => {
    const result = parseConnectionString(`databend://u:p@host/db?${query}`)!;
    expect(result.refusal).toBeUndefined();
    expect(result.ignoredParameters).toBeUndefined();
    expect(result.unnamedParameters).toBe(count);
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  test("every parameter BendSQL reads by name and Studio does not apply is named", () => {
    const names = [
      "wait_time_secs",
      "max_rows_in_buffer",
      "max_rows_per_page",
      "connect_timeout",
      "page_request_timeout_secs",
      "presign",
      "tenant",
      "role",
      "login",
      "session_token",
      "body_format",
      "query_result_format",
      "retry_count",
      "retry_delay_secs",
    ];
    const result = parseConnectionString(`databend://u:p@host/db?${names.map((name) => `${name}=1`).join("&")}`)!;
    expect(result.ignoredParameters).toEqual(names);
    expect(result.unnamedParameters).toBeUndefined();
    // Percent-encoded, a name reads as the URL parser decodes it.
    expect(parseConnectionString("databend://u:p@host/db?rol%65=r")!.ignoredParameters).toEqual(["role"]);
  });

  test("a repeated applied parameter takes its last value, as BendSQL's query_pairs loop does", () => {
    const tls = parseConnectionString("databend://u:p@host/db?sslmode=disable&sslmode=require")!;
    expect(tls.sslMode).toBe("verify-system");
    expect(tls.port).toBe("443");
    const plain = parseConnectionString("databend://u:p@host/db?sslmode=require&sslmode=disable")!;
    expect(plain.sslMode).toBe("disable");
    expect(plain.port).toBe("80");
    expect(parseConnectionString("databend://u:p@host/db?warehouse=a&warehouse=b")!.warehouse).toBe("b");
    // BendSQL refuses the DSN at an sslmode it cannot read, wherever it stands.
    const refused = parseConnectionString("databend://u:p@host/db?sslmode=bogus&sslmode=disable")!;
    expect(refused.sslMode).toBeUndefined();
    expect(refused.cautions).toEqual([DATABEND_DSN_CAUTIONS.sslmode("bogus")]);
  });

  test("an IPv6 host and a password holding a raw @ or : are read as the URL parser splits them", () => {
    const v6 = parseConnectionString("databend://u:p@[::1]:8000/db")!;
    expect(v6.host).toBe("[::1]");
    expect(v6.port).toBe("8000");
    // The last @ ends the credentials and the first : ends the user.
    const at = parseConnectionString("databend://u:p@ss@host/db")!;
    expect([at.user, at.password, at.host]).toEqual(["u", "p@ss", "host"]);
    const colon = parseConnectionString("databend://u:a:b@host/db")!;
    expect([colon.user, colon.password, colon.host]).toEqual(["u", "a:b", "host"]);
  });

  test("the not-applied notice names the parameters, counts the rest and says what the connection takes", () => {
    const takes =
      "Studio's Databend connection takes host, port, user, password, database, warehouse and TLS; the other fields were filled in.";
    expect(databendNotAppliedNotice(["role", "tenant"])).toBe(`Not applied: role, tenant. ${takes}`);
    expect(databendNotAppliedNotice(["role"], 1)).toBe(`Not applied: role and 1 other parameter. ${takes}`);
    expect(databendNotAppliedNotice(["role", "tenant"], 3)).toBe(
      `Not applied: role, tenant and 3 other parameters. ${takes}`,
    );
    expect(databendNotAppliedNotice([], 1)).toBe(`Not applied: 1 parameter. ${takes}`);
    expect(databendNotAppliedNotice([], 2)).toBe(`Not applied: 2 parameters. ${takes}`);
  });

  test("an empty warehouse= fills nothing", () => {
    expect(parseConnectionString("databend://u:p@host/db?warehouse=")!.warehouse).toBeUndefined();
  });

  test.each(["access_token", "access_token_file", "private_key_file", "private_key_passphrase_file"])(
    "%s refuses the paste and never echoes its value",
    (name) => {
      const result = parseConnectionString(`databend://u:p@host/db?warehouse=w&${name}=topsecret-value`);
      expect(result).toEqual({ type: "databend", refusal: DATABEND_DSN_REFUSALS.signIn });
      expect(JSON.stringify(result)).not.toContain("topsecret-value");
    },
  );

  test.each([
    ["databend+flight://root:@localhost:8900/db", "flight"],
    ["databend+grpc://root:@localhost:8900/db", "flight"],
    ["jdbc:databend://host:443/db?ssl=true", "jdbc"],
    ['export BENDSQL_DSN="databend://root:pw@host:8000/db"', "shellExport"],
    ["BENDSQL_DSN=databend://root:pw@host:8000/db", "shellExport"],
  ] as const)("%s is refused with its own sentence", (input, key) => {
    expect(parseConnectionString(input)).toEqual({ type: "databend", refusal: DATABEND_DSN_REFUSALS[key] });
  });

  test("each refusal sentence is its own", () => {
    const sentences = Object.values(DATABEND_DSN_REFUSALS);
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(DATABEND_DSN_REFUSALS.flight).toBe(
      "Flight SQL (port 8900) is not supported: paste the HTTP DSN, databend://, for port 8000 or 443.",
    );
    expect(DATABEND_DSN_REFUSALS.shellExport).toBe("Paste the DSN itself: the databend:// text inside the quotes.");
  });

  test("a DSN the URL parser rejects parses to null", () => {
    expect(parseConnectionString("databend://u:p@host:99999/db")).toBeNull();
  });

  test("databend is the engine's canonical scheme and detected from all three REST schemes", () => {
    expect(ENGINE_URI_SCHEMES.databend).toBe("databend");
    expect(detectConnectionStringType("databend://host")).toBe("databend");
    expect(detectConnectionStringType("Databend+HTTP://host")).toBe("databend");
    expect(detectConnectionStringType("databend+https://host")).toBe("databend");
    expect(detectConnectionStringType("databend+flight://host:8900")).toBeNull();
  });
});

// ─── Snowflake ──────────────────────────────────────────────────────────────

describe("parseConnectionString: Snowflake URLs, decomposed into fields and never kept", () => {
  /** No secret and no value the paste did not apply may appear anywhere in the result but its own field. */
  const expectOnlyIn = (result: unknown, sentinel: string, field: string) => {
    const copy = { ...(result as Record<string, unknown>) };
    expect(copy[field]).toBe(sentinel);
    delete copy[field];
    expect(JSON.stringify(copy)).not.toContain(sentinel);
  };

  test("an account URL fills the account and keeps no connection string", () => {
    const result = parseConnectionString("https://xy12345.us-east-2.aws.snowflakecomputing.com");
    expect(result).toEqual({ type: "snowflake", host: "xy12345.us-east-2.aws.snowflakecomputing.com" });
  });

  test("a bare Snowflake host is claimed, and an identifier with no suffix is not", () => {
    expect(parseConnectionString("myorg-myacct.snowflakecomputing.com")).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
    });
    expect(parseConnectionString("myorg-myacct")).toBeNull();
  });

  test("the scheme is read without regard to case, as the parameter names are (SF-024)", () => {
    expect(parseConnectionString("JDBC:SNOWFLAKE://myorg-myacct.snowflakecomputing.com/?USER=x&ROLE=r")).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
      user: "x",
      role: "r",
    });
    expect(parseConnectionString("Snowflake://u@myorg-myacct/D")).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
      user: "u",
      database: "D",
    });
    expect(detectConnectionStringType("JDBC:Snowflake://myorg-myacct.snowflakecomputing.com/")).toBe("snowflake");
  });

  test("a Snowsight URL reads the account from its path", () => {
    expect(parseConnectionString("https://app.snowflake.com/myorg/myacct/x")).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
    });
  });

  test("a JDBC URL applies its parameters, the passphrase only to its field", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=u&warehouse=wh&db=d&schema=s&role=r&authenticator=SNOWFLAKE_JWT&private_key_pwd=P-SENT",
    );
    expect(result).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
      user: "u",
      warehouse: "wh",
      database: "d",
      schema: "s",
      role: "r",
      authMethod: "keypair",
      privateKeyPassphrase: "P-SENT",
    });
    expectOnlyIn(result, "P-SENT", "privateKeyPassphrase");
    expect(result!.connectionString).toBeUndefined();
  });

  test("a SQLAlchemy URL reads user, account, database and schema, and names its password without applying it", () => {
    const result = parseConnectionString("snowflake://u:PW-SENT@myorg-myacct/d/s?warehouse=wh&role=r");
    expect(result).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
      user: "u",
      database: "d",
      schema: "s",
      warehouse: "wh",
      role: "r",
      notice: "Not applied: the password in the URL.",
    });
    expect(JSON.stringify(result)).not.toContain("PW-SENT");
  });

  test("names case-insensitively and values percent-decoded once", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?USER=a%2540b&Database=my%20db&WAREHOUSE=wh",
    );
    expect(result).toMatchObject({ user: "a%40b", database: "my db", warehouse: "wh" });
  });

  test("a token is the access token, with pat sign-in unless an authenticator chose another", () => {
    const result = parseConnectionString("https://myorg-myacct.snowflakecomputing.com/?token=S-SENT");
    expect(result).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
      password: "S-SENT",
      authMethod: "pat",
    });
    expectOnlyIn(result, "S-SENT", "password");
    expect(
      parseConnectionString(
        "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?authenticator=PROGRAMMATIC_ACCESS_TOKEN&token=T",
      ),
    ).toMatchObject({ authMethod: "pat", password: "T" });
  });

  test("an authenticator Studio does not sign in with is named and not applied", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?authenticator=externalbrowser",
    );
    expect(result!.authMethod).toBeUndefined();
    expect(result!.notice).toBe("Not applied: authenticator.");
    expect(JSON.stringify(result)).not.toContain("externalbrowser");
  });

  test("an unnamed parameter is counted, and no name or value of one is echoed", () => {
    const result = parseConnectionString("https://myorg-myacct.snowflakecomputing.com/?password=A&B&C=1");
    expect(result!.notice).toBe("Not applied: password, and 2 other parameters.");
    for (const text of ["=A", "B&", "C="]) expect(JSON.stringify(result)).not.toContain(text);
    expect(result!.password).toBeUndefined();
    const encoded = parseConnectionString("https://myorg-myacct.snowflakecomputing.com/?x%3DQ=1");
    expect(encoded!.notice).toBe("Not applied: 1 other parameter.");
    expect(JSON.stringify(encoded)).not.toContain("Q");
  });

  test("every secret-carrying name is named and never applied", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?passcode=1&oauthClientSecret=2&oauth_client_secret=3&proxyPassword=4",
    );
    expect(result!.notice).toBe("Not applied: passcode, oauthClientSecret, oauth_client_secret, proxyPassword.");
  });

  test("insecureMode and disableOCSPChecks change nothing, are named, and the TLS sentence follows", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?insecureMode=true&disableOCSPChecks=true&foo=1",
    );
    expect(result).toEqual({
      type: "snowflake",
      host: "myorg-myacct.snowflakecomputing.com",
      notice: `Not applied: insecureMode, disableOCSPChecks, and 1 other parameter. ${SNOWFLAKE_PASTE_SENTENCES.tls}`,
    });
    expect(SNOWFLAKE_PASTE_SENTENCES.tls).toBe("Studio checks TLS whatever insecureMode or disableOCSPChecks say.");
  });

  test("an inline key refuses the whole paste by name, with the key absent from the refusal", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=u&PRIVATE_KEY_BASE64=K-SENT",
    );
    expect(result).toEqual({
      type: "snowflake",
      refusal:
        "Studio does not take private_key_base64 from a pasted URL. Paste the key itself into Private key, not inside a URL.",
      discardPaste: true,
    });
    expect(JSON.stringify(result)).not.toContain("K-SENT");
    for (const name of ["private_key", "private_key_raw", "privatekey"]) {
      expect(parseConnectionString(`snowflake://u@myorg-myacct/?${name}=K`)!.refusal).toBe(
        SNOWFLAKE_PASTE_SENTENCES.inlineKey(name),
      );
    }
  });

  test("a path parameter refuses the whole paste by the list's own name, with the path absent", () => {
    for (const name of [
      "private_key_file",
      "private_key_path",
      "token_file_path",
      "client_config_file",
      "DIAGNOSTICS_ALLOWLIST_FILE",
      "CRL_RESPONSE_CACHE_DIR",
      "ocsp_response_cache_filename",
      "crl_cache_dir",
    ]) {
      const result = parseConnectionString(
        `jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?${name.toLowerCase()}=/etc/PATH-SENT`,
      );
      expect(result).toEqual({ type: "snowflake", refusal: SNOWFLAKE_PASTE_SENTENCES.path(name), discardPaste: true });
      expect(JSON.stringify(result)).not.toContain("PATH-SENT");
    }
    expect(parseConnectionString("snowflake://u@myorg-myacct/?Connection_Diag_Log_Path=/tmp/PATH-SENT")!.refusal).toBe(
      SNOWFLAKE_PASTE_SENTENCES.path("connection_diag_*_path"),
    );
    expect(SNOWFLAKE_PASTE_SENTENCES.path("private_key_file")).toBe(
      "Studio does not take private_key_file from a pasted URL. Studio reads no file: paste the key's contents into Private key.",
    );
  });

  test.each([
    "jdbc:snowflake://attacker.com/?user=x",
    "JDBC:SNOWFLAKE://attacker.com/",
    "jdbc:snowflake://myorg-myacct/?user=x",
    "jdbc:snowflake://xy12345.eu-central-1/",
    "snowflake://x@attacker.com/z",
    "snowflake://x@evil.example.org/z",
  ])("%s names a host outside Snowflake and is refused, not rewritten under its domain (SF-028)", (text) => {
    expect(parseConnectionString(text)).toEqual({
      type: "snowflake",
      refusal: SNOWFLAKE_PASTE_SENTENCES.foreignHost,
      discardPaste: true,
    });
  });

  test.each([
    ["snowflake://u@xy12345.eu-central-1/d", "xy12345.eu-central-1.snowflakecomputing.com"],
    ["snowflake://u@xy12345.us-east-2.aws.privatelink/d", "xy12345.us-east-2.aws.privatelink.snowflakecomputing.com"],
    ["snowflake://u@myorg-myacct.snowflakecomputing.com/d", "myorg-myacct.snowflakecomputing.com"],
    ["jdbc:snowflake://xy12345.eu-central-1.snowflakecomputing.com/", "xy12345.eu-central-1.snowflakecomputing.com"],
  ])("%s keeps its account", (text, host) => {
    expect(parseConnectionString(text)!.host).toBe(host);
  });

  test("an account the field would refuse refuses the paste with the account sentence", () => {
    const result = parseConnectionString("snowflake://u:PW@my%20acct/d");
    expect(result!.type).toBe("snowflake");
    expect(result!.refusal).toBe(
      "Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.",
    );
    expect(Object.keys(result!)).toEqual(["type", "refusal", "discardPaste"]);
  });

  test("an account URL on a port other than 443 is refused, and :443 is read as the account", () => {
    expect(parseConnectionString("https://myorg-myacct.snowflakecomputing.com:8443/")).toEqual({
      type: "snowflake",
      refusal:
        "Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.",
      discardPaste: true,
    });
    expect(parseConnectionString("https://myorg-myacct.snowflakecomputing.com:443/")!.host).toBe(
      "myorg-myacct.snowflakecomputing.com",
    );
  });

  test("only a Snowflake refusal asks the form to discard the pasted text, since it may hold a token or a key", () => {
    expect(parseConnectionString("snowflake://u@myorg-myacct/?private_key=K")!.discardPaste).toBe(true);
    expect(parseConnectionString("https://myorg-myacct.snowflakecomputing.com/?token=S")).not.toHaveProperty(
      "discardPaste",
    );
    // A Databend refusal leaves its text in the box to be corrected, as before.
    expect(parseConnectionString("databend+flight://root:pw@db.example.com:8900/default")).not.toHaveProperty(
      "discardPaste",
    );
  });

  test("an authenticator named like an Object member is not a sign-in method", () => {
    const result = parseConnectionString(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?authenticator=constructor",
    );
    expect(result!.authMethod).toBeUndefined();
    expect(result!.notice).toBe("Not applied: authenticator.");
  });

  test("every other https:// paste still resolves to ClickHouse", () => {
    const clickhouse = parseConnectionString("https://myacct.clickhouse.cloud:8443");
    expect(clickhouse!.type).toBe("clickhouse");
    expect(clickhouse!.host).toBe("myacct.clickhouse.cloud");
    expect(parseConnectionString("https://snowflakecomputing.com.evil.example/")!.type).toBe("clickhouse");
    expect(parseConnectionString("https://app.snowflake.com.evil.example/a/b")!.type).toBe("clickhouse");
  });

  test("detectConnectionStringType names snowflake for the same forms", () => {
    expect(detectConnectionStringType("https://xy12345.us-east-2.aws.snowflakecomputing.com")).toBe("snowflake");
    expect(detectConnectionStringType("jdbc:snowflake://a.snowflakecomputing.com/")).toBe("snowflake");
    expect(detectConnectionStringType("snowflake://u@acct/d")).toBe("snowflake");
    expect(detectConnectionStringType("https://ch.example.clickhouse.cloud")).toBe("clickhouse");
  });
});

describe("parseConnectionString: sc:// addresses (Apache Spark)", () => {
  test("hands an sc:// address to the Spark reader, which decomposes it into fields", () => {
    expect(parseConnectionString("sc://spark.example.internal:15003/;use_ssl=true;token=abc")).toEqual({
      type: "spark",
      host: "spark.example.internal",
      port: "15003",
      password: "abc",
      sslMode: "verify-system",
    });
  });

  test("hands the JDBC form to the Spark reader, which refuses it and fills nothing", () => {
    expect(parseConnectionString("jdbc:sc://h:15002")).toEqual({
      type: "spark",
      refusal: SPARK_PASTE_SENTENCES.jdbcPrefix,
    });
  });

  test("ENGINE_URI_SCHEMES names no spark scheme: the login signature would show an address Spark refuses", () => {
    expect(ENGINE_URI_SCHEMES.spark).toBeUndefined();
  });
});

// ─── case-insensitive schemes (#1916) ───────────────────────────────────────

describe("parseConnectionString: case-insensitive schemes (#1916)", () => {
  test.each([
    ["POSTGRES", "postgres", "5432"],
    ["Postgres", "postgres", "5432"],
    ["POSTGRESQL", "postgres", "5432"],
    ["MYSQL", "mysql", "3306"],
    ["Redis", "redis", "6379"],
    ["ORACLE", "oracle", "1521"],
    ["MSSQL", "mssql", "1433"],
    ["SQLSERVER", "mssql", "1433"],
    ["DB2", "db2", "50000"],
    ["CLICKHOUSE", "clickhouse", "8123"],
  ] as const)("parses %s:// URLs without regard to scheme case", (scheme, type, port) => {
    const uri = `${scheme}://User:PaSS@Host/MyDB`;
    expect(parseConnectionString(uri)).toMatchObject({
      type,
      host: "Host",
      port,
      user: "User",
      password: "PaSS",
      database: "MyDB",
    });
    expect(detectConnectionStringType(uri)).toBe(type);
  });

  test("keeps the case of the user, host and database under an uppercase scheme", () => {
    expect(parseConnectionString("POSTGRES://User@Host/MyDB")).toMatchObject({
      type: "postgres",
      host: "Host",
      user: "User",
      database: "MyDB",
    });
  });

  test("keeps the case of PostgreSQL query values and their existing precedence", () => {
    expect(
      parseConnectionString(
        "POSTGRES://User:sec@Host/MyDB?user=QueryUser&password=QuErY%2FCase&host=QueryHost&dbname=QueryDB",
      ),
    ).toMatchObject({
      type: "postgres",
      host: "QueryHost",
      user: "QueryUser",
      password: "QuErY/Case",
      database: "QueryDB",
    });
  });

  test("normalizes POSTGRESQL:// before reading a userinfo-only authority", () => {
    expect(parseConnectionString("POSTGRESQL://User@/MyDB")).toMatchObject({
      type: "postgres",
      host: "localhost",
      user: "User",
      database: "MyDB",
    });
  });

  test("normalizes MONGODB:// and preserves the rest of the URI as typed", () => {
    const suffix = "://User:PaSS@Host:27018/MyDB?appName=MyApp";
    expect(parseConnectionString(`MONGODB${suffix}`)).toMatchObject({
      type: "mongodb",
      connectionString: `mongodb${suffix}`,
      host: "Host",
      port: "27018",
      user: "User",
      password: "PaSS",
      database: "MyDB",
    });
  });

  test("MONGODB+SRV:// keeps the SRV host handling and the verifying TLS default", () => {
    const suffix = "://User:PaSS@Cluster.Example.com/MyDB?appName=MyApp";
    const result = parseConnectionString(`MONGODB+SRV${suffix}`);
    expect(result).toEqual({
      type: "mongodb",
      connectionString: `mongodb+srv${suffix}`,
      user: "User",
      password: "PaSS",
      database: "MyDB",
      sslMode: "verify-system",
    });
    expect(result).not.toHaveProperty("host");
    expect(result).not.toHaveProperty("port");
  });

  test("REDISS:// still requires TLS and Redis:// still selects plaintext", () => {
    expect(parseConnectionString("REDISS://User:PaSS@Host/MyDB")).toMatchObject({
      type: "redis",
      host: "Host",
      port: "6379",
      user: "User",
      password: "PaSS",
      database: "MyDB",
      sslMode: "require",
    });
    expect(parseConnectionString("Redis://Host")!.sslMode).toBe("disable");
  });

  test.each([
    ["DATABEND", "443", "verify-system"],
    ["DATABEND+HTTPS", "443", "verify-system"],
    ["DaTaBeNd+HtTpS", "443", "verify-system"],
    ["DATABEND+HTTP", "80", "disable"],
  ] as const)("parses %s:// with its existing TLS and port defaults", (scheme, port, sslMode) => {
    const uri = `${scheme}://User:PaSS@Host/MyDB?warehouse=MyWH`;
    expect(parseConnectionString(uri)).toEqual({
      type: "databend",
      host: "Host",
      port,
      user: "User",
      password: "PaSS",
      database: "MyDB",
      warehouse: "MyWH",
      sslMode,
      allowInsecureAuth: false,
    });
    expect(detectConnectionStringType(uri)).toBe("databend");
  });

  test.each([
    ["DATABEND+FLIGHT://Host/MyDB", DATABEND_DSN_REFUSALS.flight],
    ["DaTaBeNd+GrPc://Host/MyDB", DATABEND_DSN_REFUSALS.flight],
    ["JDBC:DATABEND://Host/MyDB", DATABEND_DSN_REFUSALS.jdbc],
    ["jdbc:DataBend://Host/MyDB", DATABEND_DSN_REFUSALS.jdbc],
  ])("keeps the existing refusal for %s", (uri, refusal) => {
    expect(parseConnectionString(uri)).toEqual({ type: "databend", refusal });
  });

  test.each([
    ["COUCHBASE", "8091", "disable"],
    ["COUCHBASES", "18091", "require"],
  ])("parses %s:// and stores the URI with a lowercase scheme", (scheme, port, sslMode) => {
    const suffix = "://User:PaSS@Host/MyBucket";
    expect(parseConnectionString(`${scheme}${suffix}`)).toMatchObject({
      type: "couchbase",
      host: "Host",
      port,
      user: "User",
      password: "PaSS",
      database: "MyBucket",
      connectionString: `${scheme.toLowerCase()}${suffix}`,
      sslMode,
    });
  });

  test("LIBSQL:// preserves the authToken value's case", () => {
    expect(parseConnectionString("LIBSQL://Db-Org.turso.io?authToken=AbCDefXYZ")).toMatchObject({
      type: "libsql",
      host: "Db-Org.turso.io",
      port: "443",
      password: "AbCDefXYZ",
      sslMode: "require",
    });
  });

  test.each([
    ["HTTP", "8123", "disable"],
    ["HTTPS", "8443", "require"],
  ])("parses %s:// as ClickHouse when the host is not Snowflake's", (scheme, port, sslMode) => {
    const uri = `${scheme}://User:PaSS@ch-host/MyDB`;
    expect(parseConnectionString(uri)).toMatchObject({
      type: "clickhouse",
      host: "ch-host",
      port,
      user: "User",
      password: "PaSS",
      database: "MyDB",
      sslMode,
    });
    expect(detectConnectionStringType(uri)).toBe("clickhouse");
  });

  test("HTTPS:// with a Snowflake host stays Snowflake ahead of ClickHouse", () => {
    const uri = "HTTPS://xy12345.us-east-2.aws.snowflakecomputing.com";
    expect(parseConnectionString(uri)).toEqual({
      type: "snowflake",
      host: "xy12345.us-east-2.aws.snowflakecomputing.com",
    });
    expect(detectConnectionStringType(uri)).toBe("snowflake");
  });

  test("SC:// reaches the Spark reader with the token's case preserved", () => {
    expect(parseConnectionString("SC://spark.example.internal:15003/;use_ssl=true;token=AbC")).toEqual({
      type: "spark",
      host: "spark.example.internal",
      port: "15003",
      password: "AbC",
      sslMode: "verify-system",
    });
  });

  test.each(["JDBC:sc://h:15002", "jdbc:SC://h:15002", "JdBc:Sc://h:15002"])(
    "%s reaches the Spark JDBC refusal without filling fields",
    (uri) => {
      expect(parseConnectionString(uri)).toEqual({
        type: "spark",
        refusal: SPARK_PASTE_SENTENCES.jdbcPrefix,
      });
    },
  );

  test("leaves an ADO.NET paste with no :// unchanged before parsing", () => {
    expect(parseConnectionString("sErVeR=MiXeDHost;Database=MyDB;User Id=User;Password=PaSS;")).toEqual({
      type: "mssql",
      host: "MiXeDHost",
      port: "1433",
      user: "User",
      password: "PaSS",
      database: "MyDB",
    });
  });

  test("does not normalize an ADO.NET prefix before a :// inside a password", () => {
    expect(
      parseConnectionString("Server=MiXeDHost;Database=MyDB;User Id=User;Password=KeepHTTPS://MiXeD/Case;"),
    ).toEqual({
      type: "mssql",
      host: "MiXeDHost",
      port: "1433",
      user: "User",
      password: "KeepHTTPS://MiXeD/Case",
      database: "MyDB",
    });
  });

  test.each(['export BENDSQL_DSN="DATABEND://User:PaSS@Host/MyDB"', "BENDSQL_DSN=DATABEND://User:PaSS@Host/MyDB"])(
    "keeps the shell-export refusal for %s",
    (input) => {
      expect(parseConnectionString(input)).toEqual({
        type: "databend",
        refusal: DATABEND_DSN_REFUSALS.shellExport,
      });
    },
  );
});
