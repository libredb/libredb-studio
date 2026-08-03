import { describe, test, expect } from "bun:test";
import { parseConnectionString, detectConnectionStringType } from "@/lib/connection-string-parser";

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

    test("returns null for a malformed couchbase URL", () => {
      expect(parseConnectionString("couchbase://:::bad")).toBeNull();
      expect(parseConnectionString("couchbases://:::bad")).toBeNull();
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
