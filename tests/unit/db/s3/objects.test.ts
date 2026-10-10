/**
 * The S3 object model: two kinds, no container level, counts and bucket rows from one
 * ListBuckets (none on a pinned connection), the bucket Source document with one part per read and a refused read as
 * its own part, and the object Source document: the address checks first, then HeadObject, tags only when the HEAD
 * counts some, and the Metadata part before any preview part.
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { ObjectHead } from "@/lib/db/providers/objectstore/s3/client";
import { S3_ERROR_SENTENCES } from "@/lib/db/providers/objectstore/s3/errors";
import {
  countS3Objects,
  describeS3Object,
  describeS3Objects,
  listS3Objects,
  readS3ObjectSource,
  requireS3Root,
  S3_OBJECT_KINDS,
  S3_OBJECTS_LISTED_ELSEWHERE,
  type S3SourceMemory,
} from "@/lib/db/providers/objectstore/s3/objects";
import type { ObjectSourceDocument, ObjectSourcePart } from "@/lib/db/types";
import { bucketsXml, errorXml, type FakeS3Handler, fakeS3Surface, xmlAnswer } from "../../../helpers/s3-fake-transport";

const CALL = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
const NO_REQUEST: FakeS3Handler = () => {
  throw new Error("no request may be sent");
};

function memory(previewParts: S3SourceMemory["previewParts"] = async () => []): S3SourceMemory {
  return { created: new Map(), previewParts };
}

function json(part: ObjectSourcePart): unknown {
  if (!("text" in part)) throw new Error(`part ${part.id} is unavailable: ${part.unavailable}`);
  return JSON.parse(part.text);
}

async function refusal(work: Promise<unknown>): Promise<string> {
  const error = await work.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(QueryError);
  return (error as Error).message;
}

test("the two kinds", () => {
  expect(S3_OBJECT_KINDS).toEqual([
    {
      id: "bucket",
      role: "config",
      label: "Bucket",
      labelPlural: "Buckets",
      hasSource: true,
      sourceLanguage: "json",
      countIsListing: true,
    },
    {
      id: "object",
      role: "config",
      label: "Object",
      labelPlural: "Objects",
      enumeratedBy: "key-browser",
      hasSource: true,
      sourceLanguage: "json",
    },
  ]);
});

describe("the tree", () => {
  test("no container level", () => {
    expect(() => requireS3Root([])).not.toThrow();
    expect(() => requireS3Root(["x"])).toThrow('An S3 connection has no container level; received ["x"]');
  });

  test("objects are listed elsewhere, and an unknown kind is refused", async () => {
    const { surface } = fakeS3Surface(NO_REQUEST);
    expect(await refusal(listS3Objects(surface, "object", CALL, new Map()))).toBe(S3_OBJECTS_LISTED_ELSEWHERE);
    expect(await refusal(listS3Objects(surface, "table", CALL, new Map()))).toBe('S3 declares no object kind "table"');
  });

  test("pinned: one bucket counted and listed with no request", async () => {
    const { surface, fake } = fakeS3Surface(NO_REQUEST, { database: "sales" });
    expect(await countS3Objects(surface, CALL)).toEqual({ bucket: { count: 1 } });
    expect(await listS3Objects(surface, "bucket", CALL, new Map())).toEqual([
      { path: ["sales"], name: "sales", kind: "bucket" },
    ]);
    expect(fake.exchanges).toHaveLength(0);
  });

  test("unpinned: one ListBuckets each, rows with their creation day, dates remembered for the Source tab", async () => {
    const { surface, fake } = fakeS3Surface(() => xmlAnswer(bucketsXml(["sales", "archive"])));
    expect(await countS3Objects(surface, CALL)).toEqual({ bucket: { count: 2 } });
    const created = new Map<string, string>();
    expect(await listS3Objects(surface, "bucket", CALL, created)).toEqual([
      { path: ["archive"], name: "archive", kind: "bucket", status: "created 2026-10-09" },
      { path: ["sales"], name: "sales", kind: "bucket", status: "created 2026-10-09" },
    ]);
    expect(created.get("sales")).toBe("2026-10-09T13:13:17.442Z");
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000", "GET /?max-buckets=10000"]);
  });

  test("a truncated list is a sample; a refused list is unavailable; another failure throws", async () => {
    const truncated = fakeS3Surface(() => xmlAnswer(bucketsXml(["a"], { continuationToken: "t" })));
    expect(await countS3Objects(truncated.surface, CALL)).toEqual({
      bucket: { count: 1, sampledFrom: "the first 10,000 buckets this key may list" },
    });
    const refused = fakeS3Surface(() => xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403));
    expect(await countS3Objects(refused.surface, CALL)).toEqual({
      bucket: {
        unavailable:
          "This access key may not list buckets (s3:ListAllMyBuckets). The server answers the same way for a bucket that does not exist. A key limited to some buckets works with one of them under Bucket.",
      },
    });
    const failing = fakeS3Surface(() => xmlAnswer(errorXml("InternalError", "boom"), 500));
    expect(await refusal(countS3Objects(failing.surface, CALL))).toBe(
      "The server failed while answering list buckets (InternalError). boom",
    );
  });

  test("a refused bucket listing fails the tree's listing with its sentence", async () => {
    const refused = fakeS3Surface(() => xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403));
    expect(await refusal(listS3Objects(refused.surface, "bucket", CALL, new Map()))).toBe(
      "This access key may not list buckets (s3:ListAllMyBuckets). The server answers the same way for a bucket that does not exist. A key limited to some buckets works with one of them under Bucket.",
    );
  });

  test("describe answers no columns and no details, with no request", () => {
    expect(describeS3Object(["sales"], "bucket")).toEqual({
      path: ["sales"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(describeS3Object(["sales/a.csv"], "object")).toEqual({
      path: ["sales/a.csv"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(describeS3Objects("bucket")).toEqual({ details: [] });
    expect(() => describeS3Object(["a", "b"], "bucket")).toThrow('An S3 "bucket" path is [name], received ["a","b"]');
  });
});

describe("the bucket Source document", () => {
  const handler: FakeS3Handler = (request) =>
    request.target.query === "location="
      ? xmlAnswer("<LocationConstraint>eu-west-1</LocationConstraint>")
      : xmlAnswer("<VersioningConfiguration/>");

  test("three parts: the bucket from memory, its location against the signing region, its versioning", async () => {
    const { surface, fake } = fakeS3Surface(handler, { database: "sales" });
    const remembered = memory();
    remembered.created.set("sales", "2026-10-09T13:13:17.442Z");
    const document = await readS3ObjectSource(surface, ["sales"], "bucket", undefined, CALL, remembered);
    expect(document.parts.map((part) => [part.id, part.label])).toEqual([
      ["bucket", "Bucket"],
      ["location", "Location"],
      ["versioning", "Versioning"],
    ]);
    expect(json(document.parts[0])).toEqual({
      bucket: "sales",
      endpoint: "http://localhost:9000",
      signing_region: "us-east-1",
      pinned: true,
      created: "2026-10-09T13:13:17.442Z",
    });
    expect(json(document.parts[1])).toEqual({
      location: "eu-west-1",
      signing_region: "us-east-1",
      note: "Requests to this bucket are signed for us-east-1; the bucket reports eu-west-1.",
    });
    expect(json(document.parts[2])).toEqual({ status: "never enabled", mfa_delete: null });
    expect(fake.lines()).toEqual(["GET /sales?location=", "GET /sales?versioning="]);
  });

  test("a refused read is its own part, and the others still show", async () => {
    const { surface } = fakeS3Surface((request) =>
      request.target.query === "location="
        ? xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403)
        : xmlAnswer("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>"),
    );
    const document = await readS3ObjectSource(surface, ["archive"], "bucket", undefined, CALL, memory());
    expect(document.parts[1]).toEqual({
      id: "location",
      label: "Location",
      unavailable:
        'This access key may not read the location of bucket "archive" (s3:GetBucketLocation). The server answers the same way for a bucket that does not exist, so this does not say that bucket "archive" exists.',
    });
    expect(json(document.parts[0])).toMatchObject({ pinned: false, created: null });
    expect(json(document.parts[2])).toEqual({ status: "Enabled", mfa_delete: null });
  });
  test("a refused versioning read is its own part too", async () => {
    const { surface } = fakeS3Surface((request) =>
      request.target.query === "location="
        ? xmlAnswer("<LocationConstraint>us-east-1</LocationConstraint>")
        : xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403),
    );
    const document = await readS3ObjectSource(surface, ["archive"], "bucket", undefined, CALL, memory());
    expect(json(document.parts[1])).toEqual({ location: "us-east-1", signing_region: "us-east-1", note: null });
    expect(document.parts[2]).toEqual({
      id: "versioning",
      label: "Versioning",
      unavailable:
        'This access key may not read the versioning of bucket "archive" (s3:GetBucketVersioning). The server answers the same way for a bucket that does not exist, so this does not say that bucket "archive" exists.',
    });
  });

  test("a closed connection is no refusal: it fails the whole document", async () => {
    const { surface } = fakeS3Surface(() => {
      throw new TransportError("aborted", "The transport is closed");
    });
    const error = await readS3ObjectSource(surface, ["archive"], "bucket", undefined, CALL, memory()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe(S3_ERROR_SENTENCES.closed);
  });
});

describe("the object Source document", () => {
  const HEAD_HEADERS: readonly (readonly [string, string])[] = [
    ["content-length", "52"],
    ["etag", '"834b9f7f9dd291dbc6083185d4ca07b0-2"'],
    ["last-modified", "Fri, 09 Oct 2026 14:04:23 GMT"],
    ["x-amz-version-id", "v1"],
    ["x-amz-meta-owner", "probe"],
    // "café" as the transport hands it: its UTF-8 bytes decoded as latin1.
    ["x-amz-meta-city", "caf\u00c3\u00a9"],
  ];
  const headWith =
    (extra: readonly (readonly [string, string])[]): FakeS3Handler =>
    (request) => {
      if (request.method === "HEAD")
        return { status: 200, headers: [...HEAD_HEADERS, ...extra], contentType: "text/csv" };
      if (request.target.query === "tagging=")
        return xmlAnswer("<Tagging><TagSet><Tag><Key>env</Key><Value>probe</Value></Tag></TagSet></Tagging>");
      throw new Error(`unexpected ${request.method} ${request.target.path}?${request.target.query}`);
    };

  test("the Metadata part's fields, tags read when the HEAD counts some, then the preview parts", async () => {
    const { surface, fake } = fakeS3Surface(headWith([["x-amz-tagging-count", "1"]]));
    let asked: { head: ObjectHead; bucket: string; key: string } | undefined;
    const preview: ObjectSourcePart = { id: "preview", label: "Preview", unavailable: "stub preview" };
    const document = await readS3ObjectSource(
      surface,
      ["sales/2026/a.csv"],
      "object",
      undefined,
      CALL,
      memory(async (input) => {
        asked = input;
        return [preview];
      }),
    );
    expect(fake.lines()).toEqual(["HEAD /sales/2026/a.csv", "GET /sales/2026/a.csv?tagging="]);
    expect(document.path).toEqual(["sales/2026/a.csv"]);
    expect(document.kind).toBe("object");
    expect(document.parts[0]).toMatchObject({
      id: "metadata",
      label: "Metadata",
      language: "json",
      origin: "rendered",
      form: "complete",
    });
    expect(json(document.parts[0])).toEqual({
      bucket: "sales",
      key: "2026/a.csv",
      size_bytes: 52,
      etag: "834b9f7f9dd291dbc6083185d4ca07b0-2",
      multipart_parts: 2,
      last_modified: "2026-10-09T14:04:23.000Z",
      content_type: "text/csv",
      content_encoding: null,
      storage_class: null,
      version_id: "v1",
      server_side_encryption: null,
      restore: null,
      archive_status: null,
      tags: { env: "probe" },
      user_metadata: { owner: ["probe"], city: ["café"] },
      missing_user_metadata: null,
      metadata_cut: false,
    });
    expect(document.parts[1]).toBe(preview);
    expect(asked).toMatchObject({ bucket: "sales", key: "2026/a.csv", head: { size: 52 } });
  });

  test("no tag count: no tagging request and tags null; a count of 0: {} with no request", async () => {
    const none = fakeS3Surface(headWith([]));
    const document = await readS3ObjectSource(none.surface, ["sales/a.csv"], "object", undefined, CALL, memory());
    expect(none.fake.lines()).toEqual(["HEAD /sales/a.csv"]);
    expect((json(document.parts[0]) as { tags: unknown }).tags).toBeNull();
    const zero = fakeS3Surface(headWith([["x-amz-tagging-count", "0"]]));
    const empty = await readS3ObjectSource(zero.surface, ["sales/a.csv"], "object", undefined, CALL, memory());
    expect((json(empty.parts[0]) as { tags: unknown }).tags).toEqual({});
    expect(zero.fake.exchanges).toHaveLength(1);
  });

  test("a refused tagging read puts its sentence beside tags: null", async () => {
    const { surface } = fakeS3Surface((request) =>
      request.method === "HEAD"
        ? { status: 200, headers: [...HEAD_HEADERS, ["x-amz-tagging-count", "2"]] }
        : xmlAnswer(errorXml("NotImplemented", "GetObjectTagging"), 501),
    );
    const document = await readS3ObjectSource(surface, ["sales/a.csv"], "object", undefined, CALL, memory());
    expect(json(document.parts[0])).toMatchObject({
      tags: null,
      tags_unavailable:
        'This server does not implement read the tags of object "a.csv": it answered 501 Not Implemented.',
    });
  });

  test("a refused HEAD is the document's only part, and no preview is asked for", async () => {
    const { surface } = fakeS3Surface(() => ({ status: 404, headers: [["x-minio-error-code", "NoSuchKey"]] }));
    let asked = false;
    const document: ObjectSourceDocument = await readS3ObjectSource(
      surface,
      ["sales/gone.csv"],
      "object",
      undefined,
      CALL,
      memory(async () => {
        asked = true;
        return [];
      }),
    );
    expect(document.parts).toEqual([
      { id: "metadata", label: "Metadata", unavailable: 'The server has no object "gone.csv" in bucket "sales".' },
    ]);
    expect(asked).toBe(false);
  });

  test("addressing refusals of the Source tab send no request", async () => {
    const pinned = fakeS3Surface(NO_REQUEST, { database: "sales" });
    expect(
      await refusal(readS3ObjectSource(pinned.surface, ["other/a.csv"], "object", undefined, CALL, memory())),
    ).toBe('This connection reads only bucket "sales"; bucket "other" is outside it.');
    expect(await refusal(readS3ObjectSource(pinned.surface, ["other"], "bucket", undefined, CALL, memory()))).toBe(
      'This connection reads only bucket "sales"; bucket "other" is outside it.',
    );
    expect(await refusal(readS3ObjectSource(pinned.surface, ["a b"], "bucket", undefined, CALL, memory()))).toBe(
      'Studio does not open bucket "a b": a bucket it addresses is 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.',
    );
    expect(
      await refusal(readS3ObjectSource(pinned.surface, ["sales//root.txt"], "object", undefined, CALL, memory())),
    ).toBe(
      'Studio does not open "/root.txt": it begins with /, and a measured S3 server read a different key for such a name (Silo reads the key without its leading slash).',
    );
    expect(await refusal(readS3ObjectSource(pinned.surface, ["sales/"], "object", undefined, CALL, memory()))).toBe(
      "A bucket's own folder has no object to open.",
    );
    expect(
      await refusal(readS3ObjectSource(pinned.surface, ["sales/../other/x"], "object", undefined, CALL, memory())),
    ).toBe(
      'Studio does not open "../other/x": once its . and .. segments are resolved, it names no object inside bucket "sales", and a server or proxy that resolves them would read something else.',
    );
    expect(pinned.fake.exchanges).toHaveLength(0);
  });
});
