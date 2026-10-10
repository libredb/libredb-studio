/**
 * Readers of each S3 response document into typed values. Each takes the parsed root, checks
 * its local name, and answers the value or `undefined` for a document that is not that shape; the client words an
 * `undefined` as E19 or E32.
 *
 * Only the local name is compared, because the namespace attribute comes and goes between servers. Names in a
 * listing are decoded only when the answer echoes `<EncodingType>url</EncodingType>`, and only `Key` and `Prefix` of
 * entries are decoded; the echoed `Prefix`, `StartAfter`, `Delimiter` and `KeyMarker` are never read, because RustFS
 * leaves them raw while MinIO and Garage encode them. A `Size` that is not a non-negative safe
 * integer, or a `KeyCount` that differs from the entries read, refuses the whole document.
 *
 * Browser-safe: no Node built-in, no server module and no `Buffer`.
 */
import type { ListedObject, ObjectListing, ObjectTag, VersionEntry, VersioningState, VersionListing } from "./client";
import { decodeListedName } from "./names";
import type { XmlElement } from "./xml";

export interface RawBucketList {
  /** In the server's order, duplicates and names holding "/" kept: the client de-duplicates, sorts and counts. */
  readonly buckets: readonly { readonly name: string; readonly created?: string }[];
  readonly truncated: boolean;
}

export interface S3ErrorDocument {
  readonly code: string;
  readonly message?: string;
  readonly region?: string;
}

const DIGITS = /^\d+$/;

function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((candidate) => candidate.name === name);
}

function childrenNamed(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((candidate) => candidate.name === name);
}

function textOf(element: XmlElement, name: string): string | undefined {
  return child(element, name)?.text;
}

/** A non-negative safe integer, or undefined. */
function wholeNumber(text: string | undefined): number | undefined {
  if (text === undefined || !DIGITS.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** One pair of surrounding quotes removed; a multipart `-<parts>` suffix kept. */
export function unquotedEtag(etag: string): string {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

/** An ISO 8601 date when `Date.parse` reads the text, else undefined. */
function isoDate(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function readBucketList(root: XmlElement): RawBucketList | undefined {
  if (root.name !== "ListAllMyBucketsResult") return undefined;
  const buckets: { name: string; created?: string }[] = [];
  for (const bucket of childrenNamed(child(root, "Buckets") ?? root, "Bucket")) {
    const name = textOf(bucket, "Name");
    if (name === undefined) return undefined;
    const created = isoDate(textOf(bucket, "CreationDate"));
    buckets.push(created === undefined ? { name } : { name, created });
  }
  return { buckets, truncated: child(root, "ContinuationToken") !== undefined };
}

export function readObjectListing(root: XmlElement): ObjectListing | undefined {
  if (root.name !== "ListBucketResult") return undefined;
  const decode = textOf(root, "EncodingType") === "url" ? decodeListedName : (raw: string) => raw;
  const keys: ListedObject[] = [];
  const prefixes: string[] = [];
  let undecodable = 0;
  let entries = 0;
  for (const element of root.children) {
    if (element.name === "Contents") {
      entries += 1;
      const raw = textOf(element, "Key");
      const size = wholeNumber(textOf(element, "Size"));
      if (raw === undefined || size === undefined) return undefined;
      const key = decode(raw);
      if (key === undefined) {
        undecodable += 1;
        continue;
      }
      const lastModified = textOf(element, "LastModified");
      const etag = textOf(element, "ETag");
      const storageClass = textOf(element, "StorageClass");
      keys.push({
        key,
        size,
        ...(lastModified ? { lastModified } : {}),
        ...(etag ? { etag: unquotedEtag(etag) } : {}),
        ...(storageClass ? { storageClass } : {}),
      });
    } else if (element.name === "CommonPrefixes") {
      for (const prefix of childrenNamed(element, "Prefix")) {
        entries += 1;
        const name = decode(prefix.text);
        if (name === undefined) undecodable += 1;
        else prefixes.push(name);
      }
    }
  }
  const keyCount = textOf(root, "KeyCount");
  if (keyCount !== undefined && wholeNumber(keyCount) !== entries) return undefined;
  const nextToken = textOf(root, "NextContinuationToken");
  return {
    keys,
    prefixes,
    undecodable,
    isTruncated: textOf(root, "IsTruncated") === "true",
    ...(nextToken ? { nextToken } : {}),
  };
}

export function readVersionListing(root: XmlElement): VersionListing | undefined {
  if (root.name !== "ListVersionsResult") return undefined;
  const decode = textOf(root, "EncodingType") === "url" ? decodeListedName : (raw: string) => raw;
  const entries: VersionEntry[] = [];
  const prefixes: string[] = [];
  let undecodable = 0;
  for (const element of root.children) {
    if (element.name === "Version" || element.name === "DeleteMarker") {
      const deleteMarker = element.name === "DeleteMarker";
      const raw = textOf(element, "Key");
      const sizeText = textOf(element, "Size");
      // A delete marker may have no Size (RustFS) or an empty one; a version must have a valid one.
      const size = deleteMarker && (sizeText === undefined || sizeText === "") ? null : wholeNumber(sizeText);
      if (raw === undefined || size === undefined) return undefined;
      const key = decode(raw);
      if (key === undefined) {
        undecodable += 1;
        continue;
      }
      const versionId = textOf(element, "VersionId");
      const lastModified = textOf(element, "LastModified");
      const etag = textOf(element, "ETag");
      entries.push({
        key,
        versionId: versionId ? versionId : null,
        isLatest: textOf(element, "IsLatest") === "true",
        deleteMarker,
        size,
        ...(lastModified ? { lastModified } : {}),
        ...(etag ? { etag: unquotedEtag(etag) } : {}),
      });
    } else if (element.name === "CommonPrefixes") {
      for (const prefix of childrenNamed(element, "Prefix")) {
        const name = decode(prefix.text);
        if (name === undefined) undecodable += 1;
        else prefixes.push(name);
      }
    }
  }
  return { entries, prefixes, undecodable, isTruncated: textOf(root, "IsTruncated") === "true" };
}

/** Empty, absent and `us-east-1` are one value, `us-east-1`; `EU` is `eu-west-1`. */
export function readLocation(root: XmlElement): string | undefined {
  if (root.name !== "LocationConstraint") return undefined;
  const location = root.text.trim();
  if (location === "") return "us-east-1";
  return location === "EU" ? "eu-west-1" : location;
}

/** No `Status` means versioning was never enabled. */
export function readVersioning(root: XmlElement): VersioningState | undefined {
  if (root.name !== "VersioningConfiguration") return undefined;
  const status = textOf(root, "Status");
  if (status !== undefined && status !== "Enabled" && status !== "Suspended") return undefined;
  return { status: status ?? null, mfaDelete: textOf(root, "MfaDelete") ?? null };
}

export function readTagging(root: XmlElement): readonly ObjectTag[] | undefined {
  if (root.name !== "Tagging") return undefined;
  const tags: ObjectTag[] = [];
  for (const tag of childrenNamed(child(root, "TagSet") ?? root, "Tag")) {
    const key = textOf(tag, "Key");
    if (key === undefined) return undefined;
    tags.push({ key, value: textOf(tag, "Value") ?? "" });
  }
  return tags;
}

/** Every element but `Code` is optional: RustFS sends only Code and Message, Garage adds Region. */
export function readErrorDocument(root: XmlElement): S3ErrorDocument | undefined {
  if (root.name !== "Error") return undefined;
  const code = textOf(root, "Code");
  if (code === undefined || code === "") return undefined;
  const message = textOf(root, "Message");
  const region = textOf(root, "Region");
  return { code, ...(message === undefined ? {} : { message }), ...(region ? { region } : {}) };
}
