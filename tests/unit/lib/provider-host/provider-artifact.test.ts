/**
 * What a provider package's artifact is (src/lib/provider-host/provider-artifact.ts): a tree of regular files with
 * portable names, walked without following a link; its digest, SHA-256 over one line per file of its mode, its
 * SHA-256 and its path; and its identity, read from package.json and libredb-provider.json at its root.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_DEPTH_LIMIT,
  ARTIFACT_FILE_LIMIT,
  type ArtifactFile,
  artifactDigest,
  compareIdentity,
  MANIFEST_BYTE_CAP,
  MANIFEST_FILE_NAME,
  PACKAGE_JSON_BYTE_CAP,
  readArtifactIdentity,
  readBoundedFile,
  resolveArtifactDirectory,
  walkArtifact,
} from "@/lib/provider-host/provider-artifact";
import { MISSING_POSIX_FILE_MODES, describeIf } from "../../../helpers/posix-tools";
import { removeScratch, scratchDirectory, writeArtifact } from "../../../helpers/provider-artifacts";

const scratch = scratchDirectory("libredb-provider-artifact-");
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
});

/** A new empty directory under the scratch root. */
function freshDirectory(): string {
  counter += 1;
  const directory = path.join(scratch, `case-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** Writes `files` (relative path to text) under `directory`. */
function writeTree(directory: string, files: Record<string, string>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** The files of a walk that must pass. */
function walked(directory: string): readonly ArtifactFile[] {
  const result = walkArtifact(directory);
  if (!result.ok) throw new Error(`the walk refused ${directory}: ${result.fault.rule}`);
  return result.files;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The fixed artifact whose digest is pinned on every platform. */
const GOLDEN_TREE: Record<string, string> = {
  "package.json": '{"name":"acme-golden","version":"1.0.0"}\n',
  "libredb-provider.json": '{"engines":[{"id":"acmegolden"}],"runtime":{"entry":"dist/index.mjs"}}\n',
  "dist/index.mjs": "export default {};\n",
  "dist/a.b": "dot\n",
  "dist/a/b": "slash\n",
};
// Pinned from Linux and computed independently there with sha256sum over the stated listing.
const GOLDEN_DIGEST = "sha256:21908458d7b7d0e2ff57c9d911b6648d2e61b37156dee850a9d6415e13024aaa";

describe("the artifact digest", () => {
  test("the digest is SHA-256 over each file's mode, SHA-256 and path, one line each in path order", () => {
    const directory = freshDirectory();
    writeTree(directory, { "z.txt": "last\n", "a.b": "dot\n", "a/b": "slash\n", "a/c/d.txt": "deep\n" });
    const files = walked(directory);
    expect(files.map((file) => file.path)).toEqual(["a.b", "a/b", "a/c/d.txt", "z.txt"]);
    const listing = [
      `644 ${sha256("dot\n")} a.b\n`,
      `644 ${sha256("slash\n")} a/b\n`,
      `644 ${sha256("deep\n")} a/c/d.txt\n`,
      `644 ${sha256("last\n")} z.txt\n`,
    ].join("");
    expect(artifactDigest(files, [])).toBe(`sha256:${sha256(listing)}`);
    // The order of the files handed in decides nothing.
    expect(artifactDigest([...files].reverse(), [])).toBe(artifactDigest(files, []));
    expect(Object.isFrozen(files)).toBe(true);
    expect(files.every((file) => Object.isFrozen(file))).toBe(true);
  });

  test("a fixed artifact has the same digest on every platform", () => {
    const directory = freshDirectory();
    writeTree(directory, GOLDEN_TREE);
    expect(artifactDigest(walked(directory), [])).toBe(GOLDEN_DIGEST);
  });

  test("the digest lists each import after the files, one line each in order, and an empty record leaves the files' digest", () => {
    const directory = freshDirectory();
    writeTree(directory, { "a.mjs": 'import "./b.mjs";\n', "b.mjs": "export {};\n" });
    const files = walked(directory);
    const fileLines = [`644 ${sha256('import "./b.mjs";\n')} a.mjs\n`, `644 ${sha256("export {};\n")} b.mjs\n`].join(
      "",
    );
    expect(artifactDigest(files, [])).toBe(`sha256:${sha256(fileLines)}`);

    const imports = [
      { from: "b.mjs", specifier: "node:fs", kind: "import" },
      { from: "a.mjs", specifier: "./b.mjs", kind: "require" },
      { from: "a.mjs", specifier: "./b.mjs", kind: "import" },
      { from: "a.mjs", specifier: "./a.mjs", kind: "import" },
    ] as const;
    const importLines =
      "import a.mjs ./a.mjs import\nimport a.mjs ./b.mjs import\nimport a.mjs ./b.mjs require\nimport b.mjs node:fs import\n";
    expect(artifactDigest(files, imports)).toBe(`sha256:${sha256(fileLines + importLines)}`);
    // The record's order decides nothing; one import more or less, or another kind, moves the digest.
    expect(artifactDigest(files, [...imports].reverse())).toBe(artifactDigest(files, imports));
    expect(artifactDigest(files, imports.slice(1))).not.toBe(artifactDigest(files, imports));
    expect(artifactDigest(files, [{ ...imports[0], kind: "require" }])).not.toBe(artifactDigest(files, [imports[0]]));
  });

  test("a file's mode is 755 where its owner execute bit is set, which Windows never reports, and 644 otherwise", () => {
    const directory = freshDirectory();
    writeTree(directory, { "run.sh": "#!/bin/sh\n", "plain.txt": "plain\n" });
    fs.chmodSync(path.join(directory, "run.sh"), 0o755);
    const modes = Object.fromEntries(walked(directory).map((file) => [file.path, file.mode]));
    expect(modes).toEqual({ "plain.txt": "644", "run.sh": process.platform === "win32" ? "644" : "755" });
  });

  describeIf(MISSING_POSIX_FILE_MODES, "file modes", () => {
    test("only the owner execute bit moves the digest: group and other bits and the umask do not", () => {
      const directory = freshDirectory();
      writeTree(directory, { "file.txt": "text\n" });
      const file = path.join(directory, "file.txt");
      const digestAt = (mode: number): string => {
        fs.chmodSync(file, mode);
        return artifactDigest(walked(directory), []);
      };
      const base = digestAt(0o644);
      for (const mode of [0o600, 0o640, 0o664, 0o666, 0o604, 0o674, 0o677]) {
        expect([mode.toString(8), digestAt(mode)]).toEqual([mode.toString(8), base]);
      }
      const executable = digestAt(0o744);
      expect(executable).not.toBe(base);
      for (const mode of [0o700, 0o755, 0o775, 0o777, 0o711]) {
        expect([mode.toString(8), digestAt(mode)]).toEqual([mode.toString(8), executable]);
      }
      expect(digestAt(0o655)).toBe(base);
    });
  });

  test("an empty directory moves no digest", () => {
    const directory = freshDirectory();
    writeTree(directory, { "a.txt": "a\n" });
    const before = artifactDigest(walked(directory), []);
    fs.mkdirSync(path.join(directory, "empty", "nested"), { recursive: true });
    expect(artifactDigest(walked(directory), [])).toBe(before);
  });
});

describe("the artifact walk", () => {
  test("a name outside letters, digits and . _ - @ + ~ is refused as PROVIDER_DIGEST_MISMATCH", () => {
    for (const name of ["with space.txt", "caf\u00e9.txt", "brackets[1].txt", "a#b", "per%cent"]) {
      const directory = freshDirectory();
      writeTree(directory, { [`nested/${name}`]: "x\n" });
      expect<unknown>([name.slice(0, 20), walkArtifact(directory)]).toEqual([
        name.slice(0, 20),
        { ok: false, fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-name" } },
      ]);
    }
    const allowed = freshDirectory();
    writeTree(allowed, { "Az09._-@+~.txt": "x\n", [`${"y".repeat(255)}`]: "y\n" });
    expect<unknown>(walkArtifact(allowed).ok).toBe(true);
  });

  test("more files or deeper directories than the limits are refused as PROVIDER_DIGEST_MISMATCH, and the limits are 10000 files and 32 levels", () => {
    expect([ARTIFACT_FILE_LIMIT, ARTIFACT_DEPTH_LIMIT]).toEqual([10_000, 32]);
    const overLimit = { ok: false, fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-over-limit" } };

    const files = freshDirectory();
    writeTree(files, { "a.txt": "a", "b.txt": "b", "c/d.txt": "d" });
    expect<unknown>(walkArtifact(files, { files: 3, depth: 32 }).ok).toBe(true);
    expect<unknown>(walkArtifact(files, { files: 2, depth: 32 })).toEqual(overLimit);

    const deep = freshDirectory();
    writeTree(deep, { "a/b/file.txt": "x" });
    expect<unknown>(walkArtifact(deep, { files: 10, depth: 2 }).ok).toBe(true);
    expect<unknown>(walkArtifact(deep, { files: 10, depth: 1 })).toEqual(overLimit);
    fs.mkdirSync(path.join(deep, "a", "b", "c"));
    expect<unknown>(walkArtifact(deep, { files: 10, depth: 2 })).toEqual(overLimit);

    const thirtyTwo = freshDirectory();
    writeTree(thirtyTwo, { [`${Array.from({ length: 32 }, () => "d").join("/")}/f.txt`]: "x" });
    expect<unknown>(walkArtifact(thirtyTwo).ok).toBe(true);
    fs.mkdirSync(path.join(thirtyTwo, ...Array.from({ length: 33 }, () => "d")));
    expect<unknown>(walkArtifact(thirtyTwo)).toEqual(overLimit);
  });

  test("a filesystem error with an errno code is a refusal naming the code, and any other error is raised", () => {
    const directory = freshDirectory();
    writeTree(directory, { "a.txt": "a\n" });

    const plain = new Error("not a filesystem answer");
    const readdir = spyOn(fs, "readdirSync").mockImplementation(() => {
      throw plain;
    });
    try {
      expect(() => walkArtifact(directory)).toThrow(plain);
    } finally {
      readdir.mockRestore();
    }

    const coded = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const open = spyOn(fs, "openSync").mockImplementation(() => {
      throw coded;
    });
    try {
      expect<unknown>(walkArtifact(directory)).toEqual({
        ok: false,
        fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-unreadable", errno: "EIO" },
      });
    } finally {
      open.mockRestore();
    }

    expect<unknown>(walkArtifact(path.join(directory, "missing"))).toEqual({
      ok: false,
      fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-unreadable", errno: "ENOENT" },
    });

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = path.join(directory, "locked");
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, "inside.txt"), "x");
      fs.chmodSync(locked, 0o000);
      try {
        expect<unknown>(walkArtifact(directory)).toEqual({
          ok: false,
          fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-unreadable", errno: "EACCES" },
        });
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  });
});

describe("reading an artifact's paths", () => {
  test("a directory whose real path cannot be read is refused naming the errno code, and any other error is raised", () => {
    const providers = freshDirectory();
    fs.mkdirSync(path.join(providers, "acme-real", "1.0.0"), { recursive: true });
    expect<unknown>(resolveArtifactDirectory(providers, "acme-real", "1.0.0")).toEqual({
      ok: true,
      directory: path.join(providers, "acme-real", "1.0.0"),
    });
    expect<unknown>(resolveArtifactDirectory(providers, "acme-real", "2.0.0")).toEqual({
      ok: false,
      fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-missing" },
    });

    const coded = Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
    const plain = new Error("not a filesystem answer");
    for (const [thrown, expected] of [
      [coded, { ok: false, fault: { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-unreadable", errno: "ELOOP" } }],
      [plain, plain],
    ] as const) {
      const real = spyOn(fs.realpathSync, "native").mockImplementation(() => {
        throw thrown;
      });
      try {
        const answer = (() => {
          try {
            return resolveArtifactDirectory(providers, "acme-real", "1.0.0");
          } catch (error) {
            return error;
          }
        })();
        expect(answer).toEqual(expected);
      } finally {
        real.mockRestore();
      }
    }
  });

  test("a file read that fails after its open is unreadable with its errno code, and any other error is raised", () => {
    const file = path.join(freshDirectory(), "file.json");
    fs.writeFileSync(file, "{}");
    expect<unknown>(readBoundedFile(file, 16)).toEqual({ ok: true, bytes: Buffer.from("{}") });

    const coded = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const failing = spyOn(fs, "readSync").mockImplementation(() => {
      throw coded;
    });
    try {
      expect<unknown>(readBoundedFile(file, 16)).toEqual({ ok: false, failure: "unreadable", errno: "EIO" });
    } finally {
      failing.mockRestore();
    }

    const plain = new Error("not a filesystem answer");
    const raising = spyOn(fs, "readSync").mockImplementation(() => {
      throw plain;
    });
    try {
      expect(() => readBoundedFile(file, 16)).toThrow(plain);
    } finally {
      raising.mockRestore();
    }
  });
});

describe("the artifact identity", () => {
  test("the identity is read from package.json and libredb-provider.json at the artifact's root, each within its byte limit", () => {
    expect([PACKAGE_JSON_BYTE_CAP, MANIFEST_BYTE_CAP]).toEqual([1024 * 1024, 2 * 1024 * 1024]);
    const directory = writeArtifact(freshDirectory(), {
      name: "@acme/provider-foo",
      version: "1.2.3-beta.1",
      engines: ["acmefoo", "acmebar"],
      entry: "lib/main.js",
    });
    expect<unknown>(readArtifactIdentity(directory)).toEqual({
      ok: true,
      identity: {
        name: "@acme/provider-foo",
        version: "1.2.3-beta.1",
        engines: ["acmebar", "acmefoo"],
        entry: "lib/main.js",
      },
    });

    const packageJson = path.join(directory, "package.json");
    const atCap = JSON.stringify({ name: "@acme/provider-foo", version: "1.2.3-beta.1" });
    fs.writeFileSync(packageJson, atCap.padEnd(PACKAGE_JSON_BYTE_CAP, " "));
    expect<unknown>(readArtifactIdentity(directory).ok).toBe(true);
    fs.writeFileSync(packageJson, atCap.padEnd(PACKAGE_JSON_BYTE_CAP + 1, " "));
    const packageUnreadable = {
      ok: false,
      fault: { code: "PROVIDER_IDENTITY_MISMATCH", rule: "package-json-unreadable" },
    };
    expect<unknown>(readArtifactIdentity(directory)).toEqual(packageUnreadable);
    for (const text of ["not json", "[]", "null", "﻿{}", ""]) {
      fs.writeFileSync(packageJson, text);
      expect<unknown>([text, readArtifactIdentity(directory)]).toEqual([text, packageUnreadable]);
    }
    fs.writeFileSync(packageJson, Buffer.from([0x7b, 0xff, 0x7d]));
    expect<unknown>(readArtifactIdentity(directory)).toEqual(packageUnreadable);
    fs.rmSync(packageJson);
    expect<unknown>(readArtifactIdentity(directory)).toEqual(packageUnreadable);
    fs.mkdirSync(packageJson);
    expect<unknown>(readArtifactIdentity(directory)).toEqual(packageUnreadable);
    fs.rmdirSync(packageJson);
    fs.writeFileSync(packageJson, atCap);

    const manifest = path.join(directory, MANIFEST_FILE_NAME);
    const manifestText = JSON.stringify({ engines: [{ id: "acmefoo" }], runtime: { entry: "lib/main.js" } });
    fs.writeFileSync(manifest, manifestText.padEnd(MANIFEST_BYTE_CAP, " "));
    expect<unknown>(readArtifactIdentity(directory).ok).toBe(true);
    fs.writeFileSync(manifest, manifestText.padEnd(MANIFEST_BYTE_CAP + 1, " "));
    expect<unknown>(readArtifactIdentity(directory)).toEqual({
      ok: false,
      fault: { code: "PROVIDER_IDENTITY_MISMATCH", rule: "manifest-unreadable" },
    });
    fs.rmSync(manifest);
    expect<unknown>(readArtifactIdentity(directory)).toEqual({
      ok: false,
      fault: { code: "PROVIDER_IDENTITY_MISMATCH", rule: "manifest-unreadable" },
    });
  });

  test("a manifest whose engines or runtime.entry are not in their form is refused naming the manifest, and its other members are never read", () => {
    const directory = writeArtifact(freshDirectory(), { name: "acme-forms", version: "1.0.0", engines: ["acmefoo"] });
    const manifest = path.join(directory, MANIFEST_FILE_NAME);
    const unreadable = { ok: false, fault: { code: "PROVIDER_IDENTITY_MISMATCH", rule: "manifest-unreadable" } };
    const runtime = { entry: "dist/index.mjs" };
    const deep = "[".repeat(10_000) + "]".repeat(10_000);
    const forms: [string, string][] = [
      ["not an object", "[]"],
      ["engines missing", JSON.stringify({ runtime })],
      ["engines not a list", JSON.stringify({ engines: { id: "acmefoo" }, runtime })],
      ["engines empty", JSON.stringify({ engines: [], runtime })],
      // The list's length is checked before any item is read, so 65 deeply nested items are never walked.
      ["65 engines", `{"engines":[${Array.from({ length: 65 }, () => deep).join(",")}],"runtime":{"entry":"a.mjs"}}`],
      ["an engine not an object", JSON.stringify({ engines: ["acmefoo"], runtime })],
      ["an id not a string", JSON.stringify({ engines: [{ id: 7 }], runtime })],
      ["an id outside its form", JSON.stringify({ engines: [{ id: "Acme" }], runtime })],
      ["an id over its length", JSON.stringify({ engines: [{ id: `a${"b".repeat(32)}` }], runtime })],
      ["one id twice", JSON.stringify({ engines: [{ id: "acmefoo" }, { id: "acmefoo" }], runtime })],
      ["runtime missing", JSON.stringify({ engines: [{ id: "acmefoo" }] })],
      ["runtime not an object", JSON.stringify({ engines: [{ id: "acmefoo" }], runtime: "dist/index.mjs" })],
      ["runtime.entry missing", JSON.stringify({ engines: [{ id: "acmefoo" }], runtime: {} })],
      ["runtime.entry not a string", JSON.stringify({ engines: [{ id: "acmefoo" }], runtime: { entry: 1 } })],
      [
        "runtime.entry with a dot segment",
        JSON.stringify({ engines: [{ id: "acmefoo" }], runtime: { entry: "../x.mjs" } }),
      ],
      [
        "runtime.entry over its length",
        JSON.stringify({ engines: [{ id: "acmefoo" }], runtime: { entry: `${"a".repeat(253)}.mjs` } }),
      ],
    ];
    for (const [label, text] of forms) {
      fs.writeFileSync(manifest, text);
      expect<unknown>([label, readArtifactIdentity(directory)]).toEqual([label, unreadable]);
    }
    // Members the identity does not read, deep or of any type, change nothing.
    fs.writeFileSync(
      manifest,
      `{"contract":${deep},"engines":[{"id":"acmefoo","rest":${deep}}],"runtime":{"entry":"dist/index.mjs","native":${deep}}}`,
    );
    expect<unknown>(readArtifactIdentity(directory)).toEqual({
      ok: true,
      identity: { name: "acme-forms", version: "1.0.0", engines: ["acmefoo"], entry: "dist/index.mjs" },
    });
  });

  test("the identity is compared with its entry field by field: name, version, engines in any order, entry", () => {
    const identity = { name: "acme-x", version: "1.0.0", engines: ["acmebar", "acmefoo"], entry: "dist/index.mjs" };
    const expected = { ...identity, engines: ["acmefoo", "acmebar"] };
    expect<unknown>(compareIdentity(identity, expected)).toBeNull();
    const mismatch = (rule: string) => ({ code: "PROVIDER_IDENTITY_MISMATCH", rule });
    expect<unknown>(compareIdentity({ ...identity, name: "acme-y" }, expected)).toEqual(mismatch("name"));
    expect<unknown>(compareIdentity({ ...identity, name: 7 }, expected)).toEqual(mismatch("name"));
    expect<unknown>(compareIdentity({ ...identity, version: "1.0.1" }, expected)).toEqual(mismatch("version"));
    expect<unknown>(compareIdentity({ ...identity, engines: ["acmefoo"] }, expected)).toEqual(mismatch("engines"));
    expect<unknown>(compareIdentity({ ...identity, engines: ["acmebar", "acmebaz"] }, expected)).toEqual(
      mismatch("engines"),
    );
    expect<unknown>(compareIdentity({ ...identity, engines: [...identity.engines, "acmebaz"] }, expected)).toEqual(
      mismatch("engines"),
    );
    expect<unknown>(compareIdentity({ ...identity, entry: "dist/other.mjs" }, expected)).toEqual(mismatch("entry"));
  });
});
