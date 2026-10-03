/**
 * The Qdrant version gates (vector-family spec 6.9, QE30): what `GET /` reports, and which keys a server older
 * than the key is refused, by name, with the version it needs.
 */
import { describe, expect, test } from "bun:test";
import {
  QDRANT_TESTED_VERSION,
  QDRANT_VERSION_GATES,
  type QdrantVersionGate,
  readQdrantVersion,
  serverHas,
  versionGateRefusal,
} from "@/lib/db/providers/vector/qdrant/versions";

const root = (version: unknown) =>
  JSON.stringify({
    title: "qdrant - vector search engine",
    version,
    commit: "6ab21cac18ebb6f4ae29102c7f8f5cc11affd5de",
  });
const GATES = Object.keys(QDRANT_VERSION_GATES) as QdrantVersionGate[];

describe("readQdrantVersion", () => {
  test.each([
    ["1.19.1", [1, 19, 1]],
    ["1.16.3", [1, 16, 3]],
    ["2.0.0", [2, 0, 0]],
    ["1.100.12", [1, 100, 12]],
  ] as const)("a plain %s is read as its three numbers", (version, release) => {
    expect(readQdrantVersion(root(version))).toEqual({ reported: version, release: [...release] });
  });

  test.each(["1.20.0-dev", "v1.19.1", "1.19", "1.19.1.2", "01.19.1", "master"])(
    "%s is reported and is no release",
    (version) => {
      expect(readQdrantVersion(root(version))).toEqual({ reported: version, release: null });
    },
  );

  test("a version that is not a short plain token is never repeated", () => {
    expect(readQdrantVersion(root("1.19.1 (the key is password)"))).toEqual({ reported: null, release: null });
    expect(readQdrantVersion(root("x".repeat(33)))).toEqual({ reported: null, release: null });
    expect(readQdrantVersion(root(""))).toEqual({ reported: null, release: null });
  });

  test.each([
    ["no version field", JSON.stringify({ title: "qdrant - vector search engine" })],
    ["a version that is not a string", root(1.19)],
    ["a body that is an array", "[]"],
    ["a body that is null", "null"],
    ["a body that is not JSON", "healthz check passed"],
    ["an empty body", ""],
  ])("%s reports none", (_name, text) => {
    expect(readQdrantVersion(text)).toEqual({ reported: null, release: null });
  });
});

describe("serverHas", () => {
  test("compares release numbers part by part, as numbers", () => {
    const at = (version: string) => readQdrantVersion(root(version));
    expect(serverHas(at("1.19.1"), [1, 19, 1])).toBe(true);
    expect(serverHas(at("1.19.0"), [1, 19, 1])).toBe(false);
    expect(serverHas(at("1.100.0"), [1, 19, 1])).toBe(true);
    expect(serverHas(at("1.9.9"), [1, 19, 0])).toBe(false);
    expect(serverHas(at("2.0.0"), [1, 19, 1])).toBe(true);
    expect(serverHas(at("0.99.99"), [1, 17, 0])).toBe(false);
  });

  test("a version that cannot be read is older than every release", () => {
    expect(serverHas(readQdrantVersion(root("1.20.0-dev")), [1, 17, 0])).toBe(false);
    expect(serverHas(readQdrantVersion("{}"), [0, 0, 0])).toBe(false);
  });
});

describe("the gate table (6.9)", () => {
  test("names exactly the keys of 6.9 with the versions they need", () => {
    expect(Object.fromEntries(GATES.map((gate) => [gate, QDRANT_VERSION_GATES[gate].needs.join(".")]))).toEqual({
      "rrf.weights": "1.17.0",
      relevance_feedback: "1.17.0",
      "params.idf": "1.19.0",
      "match.prefix": "1.19.0",
      slice: "1.19.0",
      "formula.acosh": "1.19.1",
      "formula.max": "1.19.1",
      "formula.min": "1.19.1",
    });
  });

  test("the tested version passes every gate", () => {
    const tested = readQdrantVersion(root(QDRANT_TESTED_VERSION));
    expect(tested.release).toEqual([1, 19, 1]);
    for (const gate of GATES) expect(versionGateRefusal(gate, tested)).toBeUndefined();
  });

  test("a 1.17 server refuses a 1.19 key naming the version it needs", () => {
    expect(versionGateRefusal("match.prefix", readQdrantVersion(root("1.17.1")))).toBe(
      'The match "prefix" needs Qdrant 1.19.0 or later, and this server reports 1.17.1; an older server answers an error that names no key, so nothing was sent.',
    );
    expect(versionGateRefusal("rrf.weights", readQdrantVersion(root("1.17.1")))).toBeUndefined();
  });

  test("params.idf against a 1.18 server is refused, because that server would accept it and ignore it", () => {
    expect(versionGateRefusal("params.idf", readQdrantVersion(root("1.18.3")))).toBe(
      'The key "idf" of "params" needs Qdrant 1.19.0 or later, and this server reports 1.18.3; an older server accepts it and ignores it, so nothing was sent.',
    );
  });

  test("rrf.weights against 1.16.3 is refused, because that server returns the unweighted scores", () => {
    expect(versionGateRefusal("rrf.weights", readQdrantVersion(root("1.16.3")))).toContain(
      "needs Qdrant 1.17.0 or later, and this server reports 1.16.3; an older server accepts it and returns the unweighted scores",
    );
  });

  test("the formula keys of 1.19.1 are refused on 1.19.0", () => {
    for (const gate of ["formula.acosh", "formula.max", "formula.min"] as const) {
      expect(versionGateRefusal(gate, readQdrantVersion(root("1.19.0")))).toContain("needs Qdrant 1.19.1 or later");
    }
  });

  test.each(GATES)("%s is refused on 1.20.0-dev, naming the version it needs", (gate) => {
    const refusal = versionGateRefusal(gate, readQdrantVersion(root("1.20.0-dev")));
    expect(refusal).toContain(`needs Qdrant ${QDRANT_VERSION_GATES[gate].needs.join(".")} or later`);
    expect(refusal).toContain("this server reports 1.20.0-dev, which is not a plain release number");
  });

  test.each(GATES)("%s is refused where the answer holds no version, naming the version it needs", (gate) => {
    const refusal = versionGateRefusal(gate, readQdrantVersion(JSON.stringify({ title: "qdrant" })));
    expect(refusal).toContain(`needs Qdrant ${QDRANT_VERSION_GATES[gate].needs.join(".")} or later`);
    expect(refusal).toContain("this server reported no version");
  });
});
