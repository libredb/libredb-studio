/**
 * The Weaviate version table (#1566 spec 3.3, doc 4.8): the version `GET /v1/meta` reports, the path each search
 * starts on (REST from 1.39.7, near-vector from 1.39.8, GraphQL below and for a version that cannot be read), the
 * sentence that names a version, and the warning below the 1.37 floor. The meta texts are the captured ones.
 */
import { describe, expect, test } from "bun:test";
import {
  belowFloorWarning,
  initialPath,
  REST_NEAR_VECTOR_SINCE,
  REST_SEARCH_SINCE,
  readWeaviateVersion,
  serverHas,
  versionText,
  WEAVIATE_FLOOR,
  WEAVIATE_TESTED_VERSIONS,
  type WeaviateVersion,
} from "@/lib/db/providers/vector/weaviate/versions";
import { capturedAnswer } from "../../../helpers/weaviate-wire";

const meta = (version: unknown) =>
  JSON.stringify({ grpcMaxMessageSize: 104_858_000, hostname: "http://[::]:8080", modules: {}, version });
const at = (version: string): WeaviateVersion => readWeaviateVersion(meta(version));
const NONE: WeaviateVersion = { reported: null, release: null };

describe("readWeaviateVersion", () => {
  test.each([
    ["weaviate/surface.json", "1.40.2", [1, 40, 2]],
    ["weaviate-nographql/surface.json", "1.40.2", [1, 40, 2]],
    ["weaviate-1-38/surface.json", "1.38.22", [1, 38, 22]],
    ["weaviate-1-37/surface.json", "1.37.4", [1, 37, 4]],
  ] as const)("the captured meta of %s reports %s", (file, reported, release) => {
    expect(readWeaviateVersion(capturedAnswer(file, "GET /v1/meta").text)).toEqual({ reported, release: [...release] });
  });

  test.each([
    ["2.0.0", [2, 0, 0]],
    ["1.100.12", [1, 100, 12]],
    ["v1.39.7", [1, 39, 7]],
    ["999999.0.999999", [999_999, 0, 999_999]],
  ] as const)("a plain %s is read as its three numbers", (version, release) => {
    expect(at(version)).toEqual({ reported: version, release: [...release] });
  });

  test.each(["1.41.0-rc.1", "1.40", "1.40.2.1", "01.40.2", "1.040.2", "1000000.0.0", "V1.40.2", "latest"])(
    "%s is reported and is no release",
    (version) => {
      expect(at(version)).toEqual({ reported: version, release: null });
    },
  );

  test("a version that is not a short plain token is never repeated", () => {
    expect(at("1.40.2 (key password)")).toEqual(NONE);
    expect(at("x".repeat(33))).toEqual(NONE);
    expect(at(`1.${"0".repeat(31)}`)).toEqual({ reported: null, release: null });
    expect(at("-1.40.2")).toEqual(NONE);
    expect(at("")).toEqual(NONE);
    expect(at("x".repeat(32))).toEqual({ reported: "x".repeat(32), release: null });
  });

  test.each([
    ["no version field", JSON.stringify({ hostname: "http://[::]:8080" })],
    ["a version that is not a string", meta(1.4)],
    ["a body that is an array", '["1.40.2"]'],
    ["a body that is null", "null"],
    ["a body that is a string", '"1.40.2"'],
    ["a body that is not JSON", "<html>proxy</html>"],
    ["an empty body", ""],
  ])("%s reports none", (_what, text) => {
    expect(readWeaviateVersion(text)).toEqual(NONE);
  });
});

describe("serverHas", () => {
  test("compares part by part, as numbers", () => {
    expect(serverHas(at("1.39.7"), [1, 39, 7])).toBe(true);
    expect(serverHas(at("1.39.6"), [1, 39, 7])).toBe(false);
    expect(serverHas(at("1.40.0"), [1, 39, 7])).toBe(true);
    expect(serverHas(at("1.38.100"), [1, 39, 7])).toBe(false);
    expect(serverHas(at("2.0.0"), [1, 39, 7])).toBe(true);
    expect(serverHas(at("0.99.99"), [1, 0, 0])).toBe(false);
    expect(serverHas(at("1.100.0"), [1, 99, 0])).toBe(true);
  });

  test("a version that cannot be read is older than every release", () => {
    expect(serverHas(NONE, [0, 0, 0])).toBe(false);
    expect(serverHas(at("1.41.0-rc.1"), [0, 0, 0])).toBe(false);
  });
});

describe("initialPath: the table of spec 3.3", () => {
  test("the thresholds and the floor are the measured releases", () => {
    expect(REST_SEARCH_SINCE).toEqual([1, 39, 7]);
    expect(REST_NEAR_VECTOR_SINCE).toEqual([1, 39, 8]);
    expect(WEAVIATE_FLOOR).toEqual([1, 37, 0]);
    expect(WEAVIATE_TESTED_VERSIONS).toEqual(["1.40.2", "1.38.22", "1.37.4"]);
    expect(Object.isFrozen(WEAVIATE_TESTED_VERSIONS)).toBe(true);
  });

  test.each([
    ["1.37.4", "graphql", "graphql"],
    ["1.37.17", "graphql", "graphql"],
    ["1.38.22", "graphql", "graphql"],
    ["1.39.0", "graphql", "graphql"],
    ["1.39.6", "graphql", "graphql"],
    ["1.39.7", "rest", "graphql"],
    ["1.39.8", "rest", "rest"],
    ["1.39.13", "rest", "rest"],
    ["1.40.0", "rest", "rest"],
    ["1.40.2", "rest", "rest"],
    ["2.0.0", "rest", "rest"],
  ] as const)("%s starts other searches on %s and near-vector on %s", (version, other, nearVector) => {
    expect(initialPath(at(version), "other")).toBe(other);
    expect(initialPath(at(version), "near-vector")).toBe(nearVector);
  });

  test("a version that cannot be read takes GraphQL", () => {
    for (const version of [NONE, at("1.41.0-rc.1")]) {
      expect(initialPath(version, "other")).toBe("graphql");
      expect(initialPath(version, "near-vector")).toBe("graphql");
    }
  });
});

describe("versionText", () => {
  test("a release is its three numbers, a v prefix dropped", () => {
    expect(versionText(at("1.40.2"))).toBe("1.40.2");
    expect(versionText(at("v1.39.7"))).toBe("1.39.7");
  });

  test("a reported version that is no release is repeated and named as such", () => {
    expect(versionText(at("1.41.0-rc.1"))).toBe("1.41.0-rc.1, which is not a plain release number");
  });

  test("no version is named without repeating anything", () => {
    expect(versionText(NONE)).toBe("a version it did not report");
    expect(versionText(at("1.40.2 (key password)"))).toBe("a version it did not report");
  });
});

describe("belowFloorWarning (spec 3.1)", () => {
  test("a release below 1.37 is warned of, naming it and the floor", () => {
    expect(belowFloorWarning(at("1.36.9"))).toBe(
      "This Weaviate server is 1.36.9, older than 1.37, the oldest line Studio supports; nothing below it is tested.",
    );
    expect(belowFloorWarning(at("0.22.0"))).toStartWith("This Weaviate server is 0.22.0, older than 1.37");
  });

  test("the floor and later, and a version that cannot be read, carry no warning", () => {
    for (const version of ["1.37.0", "1.37.4", "1.40.2", "2.0.0"])
      expect(belowFloorWarning(at(version))).toBeUndefined();
    expect(belowFloorWarning(NONE)).toBeUndefined();
    expect(belowFloorWarning(at("1.36.0-rc.1"))).toBeUndefined();
  });
});
