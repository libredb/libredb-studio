/**
 * The readers of each S3 response document, on the measured bodies of MinIO, Garage and
 * RustFS: names decoded only when the answer echoes `EncodingType` url, echoes never read, the `Size` and `KeyCount`
 * checks, delete markers without ETag or Size, the location and versioning defaults, namespaced and bare roots.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readBucketList,
  readErrorDocument,
  readLocation,
  readObjectListing,
  readTagging,
  readVersioning,
  readVersionListing,
  unquotedEtag,
} from "@/lib/db/providers/objectstore/s3/shapes";
import { readXml, type XmlElement } from "@/lib/db/providers/objectstore/s3/xml";

function parsed(text: string): XmlElement {
  const result = readXml(new TextEncoder().encode(text));
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.root;
}
const fixture = (name: string): XmlElement =>
  parsed(readFileSync(join(import.meta.dir, "../../../fixtures/s3/xml", name), "utf8"));

const MINIO_ETAG = "937ec4c10eb20c1f3324ef927697ea66";
const UNICODE = "sp/ünïcødé-日本.txt";

describe("readObjectListing", () => {
  test("MinIO with encoding-type=url: + is a space, %25 a percent sign", () => {
    const listing = readObjectListing(fixture("minio-list-objects-url.xml"));
    expect(listing?.keys.map((entry) => entry.key)).toEqual([
      "sp/percent%25sign.txt",
      "sp/percent%sign.txt",
      "sp/plus+sign.txt",
      "sp/with space.txt",
      UNICODE,
    ]);
    expect(listing?.keys[0]).toEqual({
      key: "sp/percent%25sign.txt",
      size: 12,
      lastModified: "2026-10-09T13:13:17.578Z",
      etag: MINIO_ETAG,
      storageClass: "STANDARD",
    });
    expect(listing).toMatchObject({ prefixes: [], undecodable: 0, isTruncated: false });
    expect(listing?.nextToken).toBeUndefined();
  });

  test("Garage's %2F and %20 encoding, dot segments, a tab and markup characters", () => {
    expect(readObjectListing(fixture("garage-list-objects-url.xml"))?.keys.map((entry) => entry.key)).toEqual([
      "sp/./dot.txt",
      "sp/double//slash.txt",
      "sp/lt<amp&.txt",
      "sp/percent%sign.txt",
      "sp/plus+sign.txt",
      "sp/tab\tchar.txt",
      "sp/with space.txt",
      "sp/x/../dotdot.txt",
      UNICODE,
    ]);
  });

  test("RustFS's raw Prefix echo is never read, and its encoded keys decode", () => {
    expect(readObjectListing(fixture("rustfs-list-objects-url.xml"))?.keys.map((entry) => entry.key)).toEqual([
      "sp/.hidden",
      "sp/name.with.dots.txt",
      "sp/percent%25sign.txt",
      "sp/percent%sign.txt",
      "sp/plus+sign.txt",
      "sp/with space.txt",
      UNICODE,
    ]);
  });

  test("without EncodingType the names are the XML text, and a common prefix is a folder", () => {
    expect(readObjectListing(fixture("minio-list-objects-delim.xml"))).toMatchObject({
      keys: [{ key: "a/top.txt", size: 12 }],
      prefixes: ["a/b/"],
    });
    const raw = parsed("<ListBucketResult><Contents><Key>a+b%20c</Key><Size>1</Size></Contents></ListBucketResult>");
    expect(readObjectListing(raw)?.keys.map((entry) => entry.key)).toEqual(["a+b%20c"]);
  });

  test("a truncated page carries its token, and an undecodable name is counted, not listed", () => {
    const page = parsed(
      [
        "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>",
        "<NextContinuationToken>tok</NextContinuationToken><KeyCount>3</KeyCount>",
        "<Contents><Key>%FF</Key><Size>1</Size></Contents><Contents><Key>ok</Key><Size>2</Size></Contents>",
        "<CommonPrefixes><Prefix>dir%2F</Prefix></CommonPrefixes></ListBucketResult>",
      ].join(""),
    );
    expect(readObjectListing(page)).toEqual({
      keys: [{ key: "ok", size: 2 }],
      prefixes: ["dir/"],
      undecodable: 1,
      isTruncated: true,
      nextToken: "tok",
    });
  });

  test("a listing without KeyCount is read; one whose KeyCount differs from its entries is refused", () => {
    const entry = "<Contents><Key>k</Key><Size>1</Size></Contents>";
    expect(readObjectListing(parsed(`<ListBucketResult>${entry}</ListBucketResult>`))?.keys).toHaveLength(1);
    expect(
      readObjectListing(parsed(`<ListBucketResult><KeyCount>2</KeyCount>${entry}</ListBucketResult>`)),
    ).toBeUndefined();
  });

  test.each(["-1", "1.5", "", "9007199254740993"])("a Size of %p refuses the document", (size) => {
    const page = parsed(`<ListBucketResult><Contents><Key>k</Key><Size>${size}</Size></Contents></ListBucketResult>`);
    expect(readObjectListing(page)).toBeUndefined();
  });

  test("an entry without Key refuses the document, and another root is not the shape", () => {
    expect(
      readObjectListing(parsed("<ListBucketResult><Contents><Size>1</Size></Contents></ListBucketResult>")),
    ).toBeUndefined();
    expect(readObjectListing(parsed("<html><body/></html>"))).toBeUndefined();
  });
});

describe("readVersionListing", () => {
  test("MinIO: a delete marker with an empty ETag and a Size of 0, then versions", () => {
    const listing = readVersionListing(fixture("minio-versions.xml"));
    expect(listing?.entries).toHaveLength(4);
    expect(listing?.entries[0]).toEqual({
      key: "ver/deleted.txt",
      versionId: "ff960b3d-5aa4-4bcd-998f-4b1750550e07",
      isLatest: true,
      deleteMarker: true,
      size: 0,
      lastModified: "2026-10-09T13:13:17.901Z",
    });
    expect(listing?.entries[1]).toMatchObject({
      key: "ver/deleted.txt",
      isLatest: false,
      deleteMarker: false,
      size: 12,
      etag: MINIO_ETAG,
    });
    expect(listing).toMatchObject({ prefixes: [], undecodable: 0, isTruncated: false });
  });

  test("RustFS: a delete marker with no ETag and no Size", () => {
    const listing = readVersionListing(fixture("rustfs-versions.xml"));
    expect(listing?.entries[0]).toEqual({
      key: "ver/deleted.txt",
      versionId: "28193ec0-a1aa-41a7-b4d4-4237a5060f36",
      isLatest: true,
      deleteMarker: true,
      size: null,
      lastModified: "2026-10-09T14:04:16.840Z",
    });
    expect(listing?.entries.map((entry) => entry.key)).toEqual([
      "ver/deleted.txt",
      "ver/deleted.txt",
      "ver/doc.txt",
      "ver/doc.txt",
    ]);
  });

  test("with EncodingType url, names and folders decode, and an undecodable name is counted, not listed", () => {
    const page = parsed(
      [
        "<ListVersionsResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>",
        "<Version><Key>%FF</Key><Size>1</Size></Version>",
        "<Version><Key>a+b</Key><VersionId>v1</VersionId><Size>2</Size></Version>",
        "<CommonPrefixes><Prefix>dir%2F</Prefix></CommonPrefixes><CommonPrefixes><Prefix>%FE</Prefix></CommonPrefixes>",
        "</ListVersionsResult>",
      ].join(""),
    );
    expect(readVersionListing(page)).toEqual({
      entries: [{ key: "a b", versionId: "v1", isLatest: false, deleteMarker: false, size: 2 }],
      prefixes: ["dir/"],
      undecodable: 2,
      isTruncated: true,
    });
  });

  test("a version without a valid Size refuses the document", () => {
    expect(
      readVersionListing(parsed("<ListVersionsResult><Version><Key>k</Key></Version></ListVersionsResult>")),
    ).toBeUndefined();
  });
});

describe("readLocation", () => {
  test("empty, absent and us-east-1 are one value; EU is eu-west-1; a region is itself", () => {
    expect(readLocation(fixture("minio-location.xml"))).toBe("us-east-1");
    expect(readLocation(fixture("rustfs-location.xml"))).toBe("us-east-1");
    expect(readLocation(fixture("garage-location.xml"))).toBe("garage-probe");
    expect(readLocation(parsed("<LocationConstraint/>"))).toBe("us-east-1");
    expect(readLocation(parsed("<LocationConstraint>EU</LocationConstraint>"))).toBe("eu-west-1");
    expect(readLocation(parsed("<Other/>"))).toBeUndefined();
  });
});

describe("readVersioning", () => {
  test("MinIO's bare root with Status, and Garage's empty document as never enabled", () => {
    expect(readVersioning(fixture("minio-versioning.xml"))).toEqual({ status: "Enabled", mfaDelete: null });
    expect(readVersioning(fixture("garage-versioning.xml"))).toEqual({ status: null, mfaDelete: null });
    expect(
      readVersioning(
        parsed(
          "<VersioningConfiguration><Status>Suspended</Status><MfaDelete>Disabled</MfaDelete></VersioningConfiguration>",
        ),
      ),
    ).toEqual({ status: "Suspended", mfaDelete: "Disabled" });
  });

  test("an unknown Status is not the shape", () => {
    expect(
      readVersioning(parsed("<VersioningConfiguration><Status>On</Status></VersioningConfiguration>")),
    ).toBeUndefined();
  });
});

describe("readTagging", () => {
  test("MinIO's bare root and RustFS's namespaced root read the same tags", () => {
    const tags = [
      { key: "env", value: "probe" },
      { key: "tier", value: "gold" },
    ];
    expect(readTagging(fixture("minio-tagging.xml"))).toEqual(tags);
    expect(readTagging(fixture("rustfs-tagging.xml"))).toEqual(tags);
  });

  test("a tag without Key refuses the document", () => {
    expect(readTagging(parsed("<Tagging><TagSet><Tag><Value>v</Value></Tag></TagSet></Tagging>"))).toBeUndefined();
  });
});

describe("readErrorDocument", () => {
  test("the three measured element sets", () => {
    expect(readErrorDocument(fixture("minio-error.xml"))).toEqual({
      code: "NoSuchKey",
      message: "The specified key does not exist.",
    });
    expect(readErrorDocument(fixture("garage-error.xml"))).toEqual({
      code: "NoSuchKey",
      message: "Key not found",
      region: "garage-probe",
    });
    expect(readErrorDocument(fixture("rustfs-error.xml"))).toEqual({
      code: "NoSuchKey",
      message: "The specified key does not exist.",
    });
  });

  test("an error without a Code is not the shape", () => {
    expect(readErrorDocument(parsed("<Error><Message>m</Message></Error>"))).toBeUndefined();
  });
});

describe("readBucketList", () => {
  test("the three servers, with and without a namespace", () => {
    expect(readBucketList(fixture("minio-buckets.xml"))).toEqual({
      buckets: [
        { name: "probe-a", created: "2026-10-09T13:13:17.442Z" },
        { name: "probe-b", created: "2026-10-09T13:13:17.444Z" },
      ],
      truncated: false,
    });
    expect(readBucketList(fixture("garage-buckets.xml"))?.buckets.map((bucket) => bucket.name)).toEqual([
      "probe-a",
      "probe-b",
    ]);
    expect(readBucketList(fixture("rustfs-buckets.xml"))?.buckets.map((bucket) => bucket.name)).toEqual([
      "probe-a",
      "probe-b",
    ]);
  });

  test("a ContinuationToken marks the list truncated; an unparsable date is left out; a bucket without Name refuses", () => {
    const list = parsed(
      "<ListAllMyBucketsResult><Buckets><Bucket><Name>a</Name><CreationDate>soon</CreationDate></Bucket></Buckets><ContinuationToken>t</ContinuationToken></ListAllMyBucketsResult>",
    );
    expect(readBucketList(list)).toEqual({ buckets: [{ name: "a" }], truncated: true });
    expect(
      readBucketList(parsed("<ListAllMyBucketsResult><Buckets><Bucket/></Buckets></ListAllMyBucketsResult>")),
    ).toBeUndefined();
  });
});

test("unquotedEtag removes one pair of quotes and keeps a multipart suffix", () => {
  expect(unquotedEtag('"834b9f7f9dd291dbc6083185d4ca07b0-2"')).toBe("834b9f7f9dd291dbc6083185d4ca07b0-2");
  expect(unquotedEtag("abc")).toBe("abc");
});
