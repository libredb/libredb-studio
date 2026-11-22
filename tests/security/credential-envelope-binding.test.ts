import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { logger } from "@/lib/logger";
import { UNDECRYPTABLE_WARNING_PREFIX } from "@/lib/storage/encrypting-provider";
import * as encryption from "@/lib/storage/encryption";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage/factory";
import type { ServerStorageProvider } from "@/lib/storage/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Property: a credential the server store seals opens only in the place it was sealed for: the row's owner, the
 * connection (or account), the field, and the connection's identity fields (docs/STORAGE.md, "Where a sealed value
 * opens"). Anywhere else it is omitted and named, as an undecryptable value is, and never returned raw.
 *
 * The first describe edits a real SQLite store with raw SQL, as an operator's tool or a restored backup would, and reads
 * it back through the provider the storage factory hands out. The second holds that no seal or open site bypasses the
 * binding: only the three storage modules that need the key import ./encryption.ts, and every seal or open it exports
 * takes a binding.
 */

const KEYS = ["STORAGE_PROVIDER", "STORAGE_SQLITE_PATH", "JWT_SECRET", "STORAGE_ENCRYPTION_KEY"] as const;

describe("a sealed credential opens only where it was stored", () => {
  const saved: Record<string, string | undefined> = {};
  const dir = mkdtempSync(join(tmpdir(), "libredb-envelope-binding-"));
  const path = join(dir, "store.db");
  let provider: ServerStorageProvider;
  const secret = { c1: randomUUID(), c2: randomUUID(), tunnel: randomUUID(), c3: randomUUID(), factor: randomUUID() };

  const record = (id: string, overrides: Record<string, unknown> = {}) =>
    ({
      id,
      name: id,
      type: "postgres",
      host: `${id}.internal`,
      user: "app",
      ...overrides,
    }) as unknown as DatabaseConnection;

  beforeAll(async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.STORAGE_SQLITE_PATH = path;
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    delete process.env.STORAGE_ENCRYPTION_KEY;
    encryption.resetStorageEncryptionKey();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      provider = (await getStorageProvider())!;
    } finally {
      warn.mockRestore();
    }
  });

  afterAll(async () => {
    await closeStorageProvider();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    encryption.resetStorageEncryptionKey();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await provider.setCollection("alice", "connections", [
      record("c1", { password: secret.c1 }),
      record("c2", { password: secret.c2, sshTunnel: { enabled: true, host: "bastion", password: secret.tunnel } }),
    ]);
    await provider.setCollection("bob", "connections", [record("c3", { password: secret.c3 })]);
    await provider.deleteAccount("ada@example.com");
    await provider.deleteAccount("bob@example.com");
    for (const [email, totpSecret] of [
      ["ada@example.com", secret.factor],
      ["bob@example.com", null],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one account write at a time on the store.
      await provider.insertAccount({
        email,
        passwordHash: "scrypt$hash",
        role: "user",
        totpSecret,
        totpPending: null,
        disabled: false,
        sessionVersion: 1,
        createdAt: "t",
        updatedAt: "t",
      });
    }
  });

  /** The stored list of `owner`, edited by `edit` and written back with raw SQL. */
  function editRow(owner: string, edit: (list: Record<string, unknown>[]) => void): void {
    const db = new Database(path);
    try {
      const row = db
        .prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = 'connections'")
        .get(owner) as { data: string };
      const list = JSON.parse(row.data);
      edit(list);
      db.prepare("UPDATE user_storage SET data = ? WHERE user_id = ? AND collection = 'connections'").run(
        JSON.stringify(list),
        owner,
      );
    } finally {
      db.close();
    }
  }

  function storedList(owner: string): Record<string, Record<string, string>>[] {
    const db = new Database(path);
    try {
      const row = db
        .prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = 'connections'")
        .get(owner) as { data: string };
      return JSON.parse(row.data);
    } finally {
      db.close();
    }
  }

  /** Reads `owner`'s connections through the provider, with the warning lines it logged. */
  async function read(owner: string): Promise<{ list: DatabaseConnection[]; warnings: string[] }> {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const list = (await provider.getCollection(owner, "connections")) ?? [];
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      return { list, warnings: warnings.filter((line) => line.startsWith(UNDECRYPTABLE_WARNING_PREFIX)) };
    } finally {
      warn.mockRestore();
    }
  }

  test("a value read back where it was stored opens, and the store holds none in the clear", async () => {
    const { list, warnings } = await read("alice");

    expect([list[0].password, list[1].password, list[1].sshTunnel?.password]).toEqual([
      secret.c1,
      secret.c2,
      secret.tunnel,
    ]);
    expect(warnings).toEqual([]);
    expect(JSON.stringify(storedList("alice"))).not.toContain(secret.c1);
  });

  test("a password moved to another connection of the row does not open", async () => {
    editRow("alice", (list) => {
      list[1].password = list[0].password;
    });

    const { list, warnings } = await read("alice");

    expect(list[0].password).toBe(secret.c1);
    expect("password" in list[1]).toBe(false);
    expect(warnings).toEqual([expect.stringContaining("c2 password (unopenable)")]);
  });

  test("a password moved into another connection's tunnel password does not open", async () => {
    editRow("alice", (list) => {
      (list[1].sshTunnel as Record<string, unknown>).password = list[0].password;
    });

    const { list, warnings } = await read("alice");

    expect(list[1].sshTunnel?.password).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("c2 sshTunnel.password (unopenable)")]);
  });

  test("a password moved into another owner's row does not open", async () => {
    const moved = storedList("alice")[0].password;
    editRow("bob", (list) => {
      list.push({ ...list[0], id: "c1", host: "c1.internal", password: moved });
    });

    const { list, warnings } = await read("bob");

    expect(list[0].password).toBe(secret.c3);
    expect("password" in list[1]).toBe(false);
    expect(warnings).toEqual([expect.stringContaining("c1 password (unopenable)")]);
  });

  test("a password whose connection's host changed does not open", async () => {
    editRow("alice", (list) => {
      list[0].host = "elsewhere.example";
    });

    const { list, warnings } = await read("alice");

    expect("password" in list[0]).toBe(false);
    expect(JSON.stringify(list)).not.toContain(secret.c1);
    expect(warnings).toEqual([expect.stringContaining("c1 password (unopenable)")]);
  });

  test("an unsealed or non-text value beside a v2 value of its record is never handed back", async () => {
    const unsealedValue = randomUUID();
    await provider.setCollection("alice", "connections", [record("c1", { password: secret.c1 })]);
    editRow("alice", (list) => {
      list[0].connectionString = unsealedValue;
    });
    const asText = await read("alice");
    expect(asText.list[0].password).toBe(secret.c1);
    expect("connectionString" in asText.list[0]).toBe(false);
    expect(asText.warnings).toEqual([expect.stringContaining("c1 connectionString (mixed)")]);

    editRow("alice", (list) => {
      list[0].connectionString = [unsealedValue];
    });
    const asList = await read("alice");
    expect("connectionString" in asList.list[0]).toBe(false);
    expect(JSON.stringify(asList.list)).not.toContain(unsealedValue);
    expect(asList.warnings).toEqual([expect.stringContaining("c1 connectionString (not-text)")]);
  });

  test("a value with one ciphertext bit flipped does not open", async () => {
    editRow("alice", (list) => {
      const [version, iv, body] = String(list[0].password).split(":");
      const bytes = Buffer.from(body, "base64url");
      bytes[0] ^= 0x01;
      list[0].password = `${version}:${iv}:${bytes.toString("base64url")}`;
    });

    const { list } = await read("alice");

    expect("password" in list[0]).toBe(false);
  });

  test("the warning names each value with its connection id, field and reason in one line", async () => {
    editRow("alice", (list) => {
      list[0].host = "elsewhere.example";
      list[1].user = "admin";
    });

    const { warnings } = await read("alice");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "3 field(s) were omitted: c1 password (unopenable), c2 password (unopenable), c2 sshTunnel.password (unopenable)",
    );
  });

  test("a factor moved to another account reads as unusable", async () => {
    const db = new Database(path);
    try {
      db.prepare(
        "UPDATE accounts SET totp_secret = (SELECT totp_secret FROM accounts WHERE email = 'ada@example.com') WHERE email = 'bob@example.com'",
      ).run();
    } finally {
      db.close();
    }
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await provider.getAccount("ada@example.com"))?.totpSecret).toBe(secret.factor);
      expect((await provider.getAccount("bob@example.com"))?.totpSecret).toBe("!unopenable");
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("bob@example.com (totpSecret)");
    } finally {
      error.mockRestore();
    }
  });
});

describe("no seal or open site bypasses the binding", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const SRC = join(ROOT, "src");

  /** Every .ts/.tsx file under src, as forward-slash paths relative to the repository root. */
  function sources(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          files.push(relative(ROOT, full).split(sep).join("/"));
        }
      }
    };
    walk(SRC);
    return files;
  }

  function parse(file: string): ts.SourceFile {
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, false, kind);
  }

  /** Whether `file` imports src/lib/storage/encryption.ts, statically or through a dynamic import. */
  function importsEncryption(file: string): boolean {
    const dir = file.split("/").slice(0, -1).join("/");
    const resolves = (specifier: string): boolean => {
      if (specifier === "@/lib/storage/encryption") return true;
      if (!specifier.startsWith(".")) return false;
      const parts = [...dir.split("/"), ...specifier.split("/")];
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === "..") resolved.pop();
        else if (part !== ".") resolved.push(part);
      }
      return resolved.join("/") === "src/lib/storage/encryption";
    };
    let found = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier) && resolves(node.moduleSpecifier.text)) found = true;
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [first] = node.arguments;
        if (first && ts.isStringLiteral(first) && resolves(first.text)) found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
    return found;
  }

  test("only the three storage modules that seal or open import the storage key code", () => {
    expect(sources().filter(importsEncryption).sort()).toEqual([
      "src/lib/storage/connection-secrets.ts",
      "src/lib/storage/encrypting-provider.ts",
      "src/lib/storage/reseal.ts",
    ]);
  }, 60_000);

  test("no other source carries the key's derivation string", () => {
    const carriers = sources().filter((file) =>
      readFileSync(join(ROOT, file), "utf8").includes("libredb-studio/storage-encryption/v1"),
    );
    expect(carriers).toEqual(["src/lib/storage/encryption.ts"]);
  }, 60_000);

  test("encryption.ts exports exactly the version, the binding-taking seal and opens, the read rule, the key check and reset, and its messages", () => {
    expect(Object.keys(encryption).sort()).toEqual(
      [
        "ENVELOPE_VERSION",
        "STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE",
        "STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE",
        "openSecret",
        "readStoredSecret",
        "requireStorageEncryptionKey",
        "resetStorageEncryptionKey",
        "sealSecret",
        "storedSecretRead",
      ].sort(),
    );
  });

  test("every seal or open it exports takes an EnvelopeBinding", () => {
    const takesBinding: Record<string, boolean> = {};
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        ["sealSecret", "openSecret", "readStoredSecret"].includes(node.name.text)
      ) {
        takesBinding[node.name.text] = node.parameters.some(
          (parameter) =>
            parameter.type !== undefined &&
            ts.isTypeReferenceNode(parameter.type) &&
            ts.isIdentifier(parameter.type.typeName) &&
            parameter.type.typeName.text === "EnvelopeBinding",
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(parse("src/lib/storage/encryption.ts"));

    expect(takesBinding).toEqual({ sealSecret: true, openSecret: true, readStoredSecret: true });
  });
});
