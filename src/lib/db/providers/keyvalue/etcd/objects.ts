/**
 * The etcd object surface (spec 4): the kinds of 4.1, the prefix-group walk of 4.3 over the ranges this
 * connection may read (4.7), the fixed columns of 4.2 and the sources of 4.4.
 *
 * One connection is one cluster and etcd holds one flat key space, so no container level is declared
 * and every path is one segment. A key is bytes and never a row: the tree lists the groups the rule of
 * 4.1 draws over the keys the walk reads, each named `<prefix>*`, the Keys panel alone enumerates keys
 * (`key-scan.ts`), and a key's Source tab is reached only by a path whose text reads back as exactly the
 * key's bytes (spec 4.6, E13).
 *
 * Every read goes through `EtcdObjectClient` (spec 3.5), carries the surface's signal, and fails through
 * `toProviderError` in this surface's words, except the answers this module words itself: a folder a
 * user who is not root may not list (spec 4.3), a member whose alarms could not be read, and a
 * compaction that overtook the walk's pinned revision, which is never the sentence for a revision a user
 * typed (plan Review Focus 2).
 */
import { DatabaseError, QueryError } from "@/lib/db/errors";
import { applySourceBound, callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  DatabaseObject,
  DatabaseType,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectPartEdit,
  ObjectReadRange,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import {
  type EtcdAlarm,
  type EtcdByteRange,
  type EtcdBytes,
  type EtcdClient,
  EtcdError,
  type EtcdInt64,
  type EtcdKeyValue,
  type EtcdLeaseTimeToLiveResponse,
  type EtcdMember,
  type EtcdPermission,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
  type EtcdStatus,
} from "./client";
import {
  type EtcdErrorConnection,
  type EtcdErrorContext,
  etcdWords,
  leaseNotFoundError,
  toProviderError,
} from "./errors";
import { assessCommand } from "./guard";
import {
  ALL_KEYS,
  decodeUtf8,
  encodeKey,
  fromHexId,
  groupLabel,
  INITIAL_PREFIX_WALK,
  INT64_MAX,
  leaseHexId,
  memberHexId,
  type PrefixGroup,
  type PrefixWalkState,
  prefixWalkResult,
  rangesIntersect,
  stepPrefixWalk,
  typedKey,
} from "./keys";
import {
  type AccessScope,
  clipToScope,
  describeScope,
  ROOT_ROLE,
  ROOT_ROLE_HOLDS_EVERY_KEY,
  rangeCovered,
  rangeShape,
} from "./permissions";
import { type ValueView, viewKey, viewValue } from "./values";
import { type ReadOnlySource, refuseBeforeSend } from "./write-policy";

const PROVIDER: DatabaseType = "etcd";

/** What every surface call carries; index.ts builds one per call. */
export interface EtcdSurfaceContext {
  /**
   * What this connection may read (spec 4.7): `{ kind: "all" }` with auth off, for root, and for a user
   * whose grants read every key.
   */
  readonly readable: AccessScope;
  /** What it may write (spec 4.7, the edit offer). */
  readonly writable: AccessScope;
  /**
   * The etcd user this connection signs in as: carried whenever auth is on and the user does not hold root
   * (spec 4.7), whatever its grants read, and never otherwise. A context that carries it is scoped, so the
   * prefix count, the error table's may-read list (5.6) and the refusals of 4.3 name this user.
   */
  readonly principal?: { readonly name: string; readonly via: "password" | "certificate" };
  readonly readOnly?: ReadOnlySource;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly errors: EtcdErrorConnection;
}

export type EtcdObjectClient = Pick<
  EtcdClient,
  | "range"
  | "memberList"
  | "status"
  | "alarmList"
  | "leaseLeases"
  | "leaseTimeToLive"
  | "userList"
  | "userGet"
  | "roleList"
  | "roleGet"
>;

/**
 * Spec 4.1: prefix, key (enumeratedBy "key-browser"), member, lease, user and role (the last three
 * countIsListing). Every kind but the key draws a folder; the key has a Source tab and a value edit.
 */
export const ETCD_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "prefix", role: "relation", label: "Key Prefix", labelPlural: "Key Prefixes", hasColumns: true },
  {
    id: "key",
    role: "config",
    label: "Key",
    labelPlural: "Keys",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "json",
    acceptsSourceEdits: true,
  },
  { id: "member", role: "config", label: "Member", labelPlural: "Members", hasSource: true, sourceLanguage: "json" },
  {
    id: "lease",
    role: "config",
    label: "Lease",
    labelPlural: "Leases",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "user",
    role: "config",
    label: "User",
    labelPlural: "Users",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "role",
    role: "config",
    label: "Role",
    labelPlural: "Roles",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
] as const);

// The walk's bounds (spec 4.3), kept by Task 22's measurement on 2026-10-01 (KE1: over a key space of 401,440
// keys, the walk stopped at S after 290 ms with 388 groups).
/** G (KE1): the most groups the tree and the inventory hold, below `INVENTORY_LIMIT`. */
export const ETCD_GROUP_CAP = 1_000;
/** S (KE1): the most keys one walk reads, so it ends within the query timeout. */
export const ETCD_WALK_KEY_CAP = 100_000;
/** P (KE1, R13 D9), below S: the most keys one undecided first segment may take before it is recorded `F/*`. */
export const ETCD_WALK_SEGMENT_BUDGET = 20_000;
/** The walk's first page (KE1), grown while pages stay small. */
export const ETCD_WALK_FIRST_PAGE = 100;
/** The ceiling the walk's page size grows to (KE1). */
export const ETCD_WALK_MAX_PAGE = 10_000;
/** A page whose keys take fewer bytes than this is small, so the next page is twice its size (KE1). */
export const ETCD_WALK_PAGE_BYTES = 1_048_576;

/** Every declared kind but `key`, which the Keys panel alone enumerates (spec 3.4): what is counted and listed. */
const LISTED_KINDS = ["prefix", "member", "lease", "user", "role"] as const;
type ListedKind = (typeof LISTED_KINDS)[number];

/** The surface's own words for each listing, as the error table places them after "the" (spec 5.6). */
const LISTING: Readonly<Record<ListedKind, string>> = {
  prefix: "Key Prefixes listing",
  member: "Members listing",
  lease: "Leases listing",
  user: "Users listing",
  role: "Roles listing",
};

/** Spec 4.2: the fields every key row of 5.2 answers, so a group is described without a read. */
const PREFIX_COLUMNS: readonly ColumnSchema[] = Object.freeze([
  { name: "key", type: "string", nullable: false, isPrimary: true },
  { name: "value", type: "json", nullable: true, isPrimary: false },
  { name: "value_encoding", type: "string", nullable: true, isPrimary: false },
  { name: "create_revision", type: "string", nullable: false, isPrimary: false },
  { name: "mod_revision", type: "string", nullable: false, isPrimary: false },
  { name: "version", type: "string", nullable: false, isPrimary: false },
  { name: "lease", type: "string", nullable: true, isPrimary: false },
]);

const count = (n: number) => n.toLocaleString("en-US");

/** The floors of spec 4.3, each phrased to follow "counted from". */
const WALK_BOUNDS = {
  groups: `one key-prefix walk capped at ${count(ETCD_GROUP_CAP)} groups`,
  keys: `one key-prefix walk that stopped after ${count(ETCD_WALK_KEY_CAP)} keys`,
  segment: `one key-prefix walk that read at most ${count(ETCD_WALK_SEGMENT_BUDGET)} keys under any one prefix`,
} as const;

/** The undecided row's title (spec 4.3, R13 D9): the segment reached P, so it holds at least P keys. */
const UNDECIDED_STATUS = `At least ${count(ETCD_WALK_SEGMENT_BUDGET)} keys; this prefix was not read to the end, so its deeper groups are not listed`;

const KEY_KIND_LISTED_ELSEWHERE =
  'The etcd kind "key" is listed by the Keys panel alone, a page at a time: open the Keys panel to walk the keys.';
const METADATA_NOT_EDITED = "etcd keeps a key's metadata itself: only its value is edited.";
/** Spec 4.5's build refuses the same fact in these words, so one fact reads as one sentence on both surfaces. */
const VALUE_NOT_TEXT = "The value is not UTF-8 text, so it is shown as base64 and is not edited here.";

/**
 * The etcd user a scoped sentence names. The provider carries the principal whenever auth is on and the
 * user does not hold root (spec 4.7), the one case in which a scope of ranges exists or etcd refuses a
 * listing for want of root, so a context that reaches here without one was built wrong by the provider:
 * a defect, raised rather than worded around.
 */
function scopedUser(context: EtcdSurfaceContext): string {
  if (context.principal === undefined) {
    throw new Error(
      "An etcd surface context scoped to a user's grants carries no principal: the provider builds both from one connect (spec 4.7)",
    );
  }
  return context.principal.name;
}

/**
 * The etcd user whose grants scope this context, or undefined for one no grants scope (spec 4.7): a
 * principal scopes it even when its grants read every key, and a scope of ranges without one raises
 * `scopedUser`'s defect.
 */
function scopedBy(context: EtcdSurfaceContext): string | undefined {
  if (context.principal === undefined && context.readable.kind === "all") return undefined;
  return scopedUser(context);
}

/**
 * What a user may read as a sentence the agent reads names it (E13): every key, or how many ranges, never
 * one, because a range may be a single key; the merged ranges, as the walk reads them.
 */
function countedScope(scope: AccessScope): string {
  if (scope.kind === "all") return describeScope(scope);
  const ranges = clipToScope(ALL_KEYS, scope).length;
  return `${count(ranges)} range${ranges === 1 ? "" : "s"}`;
}

/**
 * The error table's context for one surface call (spec 5.6): the surface's words, whether it writes,
 * the range it asked for, and, where spec 4.7 read the grants, what the user may read. A read whose
 * refusal the agent reads as well, the key-prefix walk, which the tree also draws, and the Tables panel's
 * counts, passes `rangesCounted`, so what the user may read is named by how many ranges and never by one
 * (E13), as the prefix count's `sampledFrom` names it (spec 4.7).
 */
export function surfaceErrorContext(
  context: EtcdSurfaceContext,
  command: string,
  detail: { readonly write?: boolean; readonly range?: string; readonly rangesCounted?: boolean } = {},
): EtcdErrorContext {
  const user = scopedBy(context);
  const ranges = detail.rangesCounted === true ? countedScope(context.readable) : describeScope(context.readable);
  return {
    command,
    write: detail.write === true,
    ...(detail.range === undefined ? {} : { range: detail.range }),
    ...(user === undefined ? {} : { readable: { user, ranges } }),
    connection: context.errors,
  };
}

/** One read, its failure through the one error table in this surface's words (spec 5.6, E16). */
async function surfaceRead<T>(call: () => Promise<T>, context: EtcdSurfaceContext, command: string, range?: string) {
  try {
    return await call();
  } catch (error) {
    throw toProviderError(error, surfaceErrorContext(context, command, range === undefined ? {} : { range }));
  }
}

interface Reading {
  readonly rows: readonly DatabaseObject[];
  /** Present only when the count is a floor (spec 4.3, 4.7). */
  readonly sampledFrom?: string;
}

/**
 * What one walk carries from page to page, and from one readable range to the next (spec 4.3, 4.7).
 * S bounds `state.keysRead`, every key the pages held, grouped or not (keys.ts `PrefixWalkState`).
 */
interface WalkProgress {
  state: PrefixWalkState;
  /** The first page's revision, which every later page reads at. */
  revision?: EtcdInt64;
  pageSize: number;
}

type WalkStop = "groups" | "keys";

function keyBytes(keys: readonly EtcdBytes[]): number {
  return keys.reduce((sum, key) => sum + key.length, 0);
}

/** One keys_only page from `cursor` to the end of `piece`, at the walk's revision once the first page pinned it. */
async function walkPage(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  progress: WalkProgress,
  piece: EtcdByteRange,
  cursor: EtcdBytes,
): Promise<EtcdRangeResponse> {
  const request: EtcdRangeRequest = {
    key: cursor,
    ...(piece.rangeEnd === undefined ? {} : { rangeEnd: piece.rangeEnd }),
    limit: Math.min(progress.pageSize, ETCD_WALK_KEY_CAP - progress.state.keysRead),
    keysOnly: true,
    ...(progress.revision === undefined ? {} : { revision: progress.revision }),
  };
  try {
    const answer = await client.range(request, { signal: context.signal });
    if (progress.revision === undefined) progress.revision = answer.header.revision;
    return answer;
  } catch (error) {
    if (request.revision !== undefined && error instanceof EtcdError && error.category === "compacted") {
      throw new QueryError(
        `A compaction overtook the key-prefix walk: etcd compacted revision ${request.revision}, the revision its pages are pinned to, after the first page was read, so the groups read are not the whole listing and none is shown. Refresh the object tree to run the walk again.${etcdWords(error)}`,
        PROVIDER,
      );
    }
    // Each piece is one of the user's grants, which may be a single key, so the refusal names none (E13).
    throw toProviderError(error, surfaceErrorContext(context, LISTING.prefix, { rangesCounted: true }));
  }
}

/**
 * Where the read of one readable range starts (spec 4.3, 4.7): at its first key, or at the end of a
 * recorded group that holds that key, so no key inside a group is read beyond the page that found it;
 * undefined when that group holds the whole range.
 */
function unreadStart(piece: EtcdByteRange, recorded: readonly PrefixGroup[]): EtcdBytes | undefined {
  const holding = recorded.find((group) => rangesIntersect({ key: piece.key }, group.range));
  if (holding === undefined) return piece.key;
  const end = holding.range.rangeEnd;
  return end !== undefined && rangesIntersect({ key: end }, piece) ? end : undefined;
}

/** One readable range from `start`, page by page, until it is read, a bound stops the walk, or a jump leaves it. */
async function walkPiece(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  progress: WalkProgress,
  piece: EtcdByteRange,
  start: EtcdBytes | undefined,
): Promise<WalkStop | undefined> {
  let cursor = start;
  while (cursor !== undefined) {
    if (progress.state.keysRead >= ETCD_WALK_KEY_CAP) return "keys";
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the one before it ended.
    const answer = await walkPage(client, context, progress, piece, cursor);
    const keys = answer.kvs.map((kv) => kv.key);
    const step = stepPrefixWalk(
      progress.state,
      { keys, more: answer.more },
      { segmentBudget: ETCD_WALK_SEGMENT_BUDGET },
    );
    progress.state = step.state;
    if (prefixWalkResult(progress.state, false).length > ETCD_GROUP_CAP) return "groups";
    if (keyBytes(keys) < ETCD_WALK_PAGE_BYTES) progress.pageSize = Math.min(progress.pageSize * 2, ETCD_WALK_MAX_PAGE);
    cursor = step.next !== undefined && rangesIntersect({ key: step.next }, piece) ? step.next : undefined;
  }
  return undefined;
}

/**
 * The prefix-group walk of spec 4.3 over the ranges this connection may read (4.7): one rule applied to
 * the keys every readable range holds together, so each group is listed once. Past `G` groups the
 * listing holds the first `G`; past `S` keys it holds the groups decided so far.
 */
async function walkPrefixGroups(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
): Promise<{ readonly groups: readonly PrefixGroup[]; readonly stoppedBy?: WalkStop }> {
  const progress: WalkProgress = { state: INITIAL_PREFIX_WALK, pageSize: ETCD_WALK_FIRST_PAGE };
  let stoppedBy: WalkStop | undefined;
  for (const piece of clipToScope(ALL_KEYS, context.readable)) {
    const start = unreadStart(piece, prefixWalkResult(progress.state, false));
    // oxlint-disable-next-line no-await-in-loop -- the ranges are read in byte order, one walk over all of them.
    stoppedBy = await walkPiece(client, context, progress, piece, start);
    if (stoppedBy !== undefined) break;
  }
  const decided = prefixWalkResult(progress.state, stoppedBy === undefined);
  if (decided.length > ETCD_GROUP_CAP) return { groups: decided.slice(0, ETCD_GROUP_CAP), stoppedBy: "groups" };
  return stoppedBy === undefined ? { groups: decided } : { groups: decided, stoppedBy };
}

/**
 * A listed group's `readRanges` (spec 3.4, 4.7): the pieces of its range the scope reads, or undefined
 * when the scope covers the range; a piece whose bytes are not UTF-8 is left out, so no generated read
 * addresses other bytes, and a group whose every piece is left out answers an empty list.
 */
export function groupReadRanges(group: PrefixGroup, scope: AccessScope): readonly ObjectReadRange[] | undefined {
  if (rangeCovered(group.range, scope)) return undefined;
  return clipToScope(group.range, scope).flatMap((piece): ObjectReadRange[] => {
    const shape = rangeShape(piece);
    if (shape.shape === "key") {
      const key = decodeUtf8(shape.key);
      return key === undefined ? [] : [{ key }];
    }
    if (shape.shape === "prefix") {
      const prefix = decodeUtf8(shape.prefix);
      return prefix === undefined ? [] : [{ prefix }];
    }
    const start = decodeUtf8(shape.start);
    const end = decodeUtf8(shape.end);
    return start === undefined || end === undefined ? [] : [{ start, end }];
  });
}

function prefixRow(group: PrefixGroup, scope: AccessScope): DatabaseObject {
  const label = groupLabel(group);
  const readRanges = groupReadRanges(group, scope);
  return {
    path: [label],
    name: label,
    kind: "prefix",
    ...(group.undecided === true ? { status: UNDECIDED_STATUS } : {}),
    ...(readRanges === undefined ? {} : { readRanges }),
  };
}

/**
 * The prefix count's `sampledFrom` (spec 4.3, 4.7): the bound that made it a floor and the scope it was
 * walked under, and never a range (E13).
 */
function prefixSampledFrom(bound: WalkStop | "segment" | undefined, context: EtcdSurfaceContext): string | undefined {
  const walked = bound === undefined ? undefined : WALK_BOUNDS[bound];
  const user = scopedBy(context);
  if (user === undefined) return walked;
  // The readable ranges as the walk reads them, so grants that read every key are the 1 range.
  const ranges = clipToScope(ALL_KEYS, context.readable).length;
  const scope = `the ${count(ranges)} range${ranges === 1 ? "" : "s"} etcd user ${user} may read`;
  return walked === undefined ? scope : `${walked}, over ${scope}`;
}

async function readPrefixGroups(client: EtcdObjectClient, context: EtcdSurfaceContext): Promise<Reading> {
  const walk = await walkPrefixGroups(client, context);
  const undecided = walk.groups.some((group) => group.undecided === true);
  const sampledFrom = prefixSampledFrom(walk.stoppedBy ?? (undecided ? "segment" : undefined), context);
  return {
    rows: walk.groups.map((group) => prefixRow(group, context.readable)),
    ...(sampledFrom === undefined ? {} : { sampledFrom }),
  };
}

function memberLabel(member: EtcdMember): string {
  const id = memberHexId(member.id);
  return member.name === "" ? id : `${member.name} (${id})`;
}

/** The alarms raised on one member, in etcd's words (NOSPACE, CORRUPT), or undefined for none (spec 4.1). */
function memberAlarms(alarms: readonly EtcdAlarm[] | EtcdError, member: EtcdMember): string | undefined {
  if (alarms instanceof EtcdError) return `The alarms raised on this member could not be read${etcdWords(alarms)}`;
  const raised = alarms.filter((alarm) => alarm.memberId === member.id).map((alarm) => alarm.alarm.toUpperCase());
  return raised.length === 0 ? undefined : raised.join(", ");
}

function memberRow(member: EtcdMember, alarms: readonly EtcdAlarm[] | EtcdError): DatabaseObject {
  const id = memberHexId(member.id);
  const status = memberAlarms(alarms, member);
  return { path: [id], name: memberLabel(member), kind: "member", ...(status === undefined ? {} : { status }) };
}

/** Members from a serializable MemberList, so the tree answers during a quorum loss (spec 4.3). */
async function readMembers(client: EtcdObjectClient, context: EtcdSurfaceContext): Promise<Reading> {
  const options = { signal: context.signal };
  const [listed, alarms] = await Promise.all([
    surfaceRead(() => client.memberList({ linearizable: false }, options), context, LISTING.member),
    client.alarmList(options).then(
      (answer) => answer,
      (error: unknown) => {
        // The folder still lists the members: each one's status says its alarms could not be read.
        if (error instanceof EtcdError) return error;
        throw error;
      },
    ),
  ]);
  return { rows: listed.members.map((member) => memberRow(member, alarms)) };
}

/** The refusals of spec 4.3 for a folder a user who is not root may not list; the count is the listing. */
const LISTING_REFUSED: Readonly<Record<"lease" | "user" | "role", (context: EtcdSurfaceContext) => string>> = {
  lease: () => "Listing leases needs READ on every leased key in the cluster",
  user: (context) => `Listing users needs the etcd root role, which ${scopedUser(context)} does not hold`,
  role: (context) => `Listing roles needs the etcd root role, which ${scopedUser(context)} does not hold`,
};

async function refusableListing<T>(
  call: () => Promise<T>,
  context: EtcdSurfaceContext,
  kind: "lease" | "user" | "role",
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EtcdError && error.category === "permission-denied") {
      throw new QueryError(`${LISTING_REFUSED[kind](context)}${etcdWords(error)}`, PROVIDER);
    }
    throw toProviderError(error, surfaceErrorContext(context, LISTING[kind]));
  }
}

/** The lease count's floor when leases were left out, phrased to follow "counted from" (`KindCount`). */
function negativeLeasesLeftOut(left: number): string {
  return `the leases with a positive id, leaving out ${count(left)} lease${left === 1 ? "" : "s"} with a negative id, which etcd holds only when a client chose it and Studio does not address`;
}

/**
 * The leases as lease list prints them, in order. A negative id, which etcd grants only when a client
 * chose it, is written as Go writes it (keys.ts `leaseHexId`), and neither keys.ts `fromHexId` nor the
 * command grammar (commands.ts `leaseId`) reads that back, so a row carrying it would open a Source tab
 * and a typed lease command that are both refused: it is left out, and the count is a floor that says
 * how many were, never a silent absence.
 */
async function readLeases(client: EtcdObjectClient, context: EtcdSurfaceContext): Promise<Reading> {
  const answer = await refusableListing(() => client.leaseLeases({ signal: context.signal }), context, "lease");
  const addressed = answer.ids.filter((id) => fromHexId(leaseHexId(id)) === id);
  const ids = addressed.map(leaseHexId).sort();
  const left = answer.ids.length - addressed.length;
  return {
    rows: ids.map((id) => ({ path: [id], name: id, kind: "lease" })),
    ...(left === 0 ? {} : { sampledFrom: negativeLeasesLeftOut(left) }),
  };
}

async function readNames(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  kind: "user" | "role",
): Promise<Reading> {
  const options = { signal: context.signal };
  const names = await refusableListing(
    () => (kind === "user" ? client.userList(options) : client.roleList(options)),
    context,
    kind,
  );
  return { rows: names.map((name) => ({ path: [name], name, kind })) };
}

/** One private reader per kind feeds both the count and the listing, and the count is the listed length (spec 4.3). */
function readKind(client: EtcdObjectClient, context: EtcdSurfaceContext, kind: ListedKind): Promise<Reading> {
  switch (kind) {
    case "prefix":
      return readPrefixGroups(client, context);
    case "member":
      return readMembers(client, context);
    case "lease":
      return readLeases(client, context);
    case "user":
    case "role":
      return readNames(client, context, kind);
  }
}

function isListedKind(kind: string): kind is ListedKind {
  return (LISTED_KINDS as readonly string[]).includes(kind);
}

/**
 * Every kind the tree draws a folder for, each read on its own, so a refused or failed read answers that
 * kind `{ unavailable }` in the provider's words and the others are still counted; the key is left out
 * (spec 3.4). A thrown value that is not a database error is a defect and surfaces as itself.
 */
export async function countEtcdObjects(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
): Promise<Record<string, KindCount>> {
  const settled = await Promise.allSettled(LISTED_KINDS.map((kind) => readKind(client, context, kind)));
  return Object.fromEntries(
    LISTED_KINDS.map((kind, index): [string, KindCount] => {
      const outcome = settled[index];
      if (outcome.status === "rejected") {
        if (!(outcome.reason instanceof DatabaseError)) throw outcome.reason;
        return [kind, { unavailable: outcome.reason.message }];
      }
      const { rows, sampledFrom } = outcome.value;
      return [kind, sampledFrom === undefined ? { count: rows.length } : { count: rows.length, sampledFrom }];
    }),
  );
}

/** One kind's objects; a refused read raises in the provider's words and never answers [] (spec 4.3). */
export async function listEtcdObjects(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  kind: string,
): Promise<DatabaseObject[]> {
  if (kind === "key") throw new QueryError(KEY_KIND_LISTED_ELSEWHERE, PROVIDER);
  if (!isListedKind(kind)) throw new QueryError(`etcd declares no object kind "${kind}"`, PROVIDER);
  return [...(await readKind(client, context, kind)).rows];
}

/** Every etcd path is one segment: no container level is declared, and no kind is attached to another. */
function requireKindPath(path: readonly string[], kind: string): void {
  if (!ETCD_OBJECT_KINDS.some((spec) => spec.id === kind)) {
    throw new QueryError(`etcd declares no object kind "${kind}"`, PROVIDER);
  }
  if (path.length !== 1) {
    throw new QueryError(`An etcd "${kind}" path is [name], received ${JSON.stringify(path)}`, PROVIDER);
  }
}

/** The fixed columns of spec 4.2 for a group, none for any other kind, and no read. */
export function describeEtcdObject(path: readonly string[], kind: string): ObjectDetail {
  requireKindPath(path, kind);
  if (kind === "prefix" && !path[0].endsWith("/*")) {
    throw new QueryError(
      `An etcd "prefix" path names a key-prefix group such as /app/*, received ${JSON.stringify(path)}`,
      PROVIDER,
    );
  }
  return { path: [...path], columns: kind === "prefix" ? PREFIX_COLUMNS : [], indexes: [], foreignKeys: [] };
}

/**
 * Every listed group's columns in one answer (spec 4.2). The walk's own bounds are never reported here:
 * past `G` or `S` the listing holds the groups read and says so through the count's `sampledFrom`, and a
 * batch marked truncated would end the agent's walk before the members, leases, users and roles (spec
 * 4.3, R12 CIC-3). Only a caller's bound truncates, in the one shared sentence.
 */
export function describeEtcdObjects(
  kind: string,
  listed: readonly DatabaseObject[],
  limit?: number,
): ObjectDetailBatch {
  if (!ETCD_OBJECT_KINDS.some((spec) => spec.id === kind)) {
    throw new QueryError(`etcd declares no object kind "${kind}"`, PROVIDER);
  }
  if (kind !== "prefix") return { details: [] };
  const detail = (object: DatabaseObject): ObjectDetail => ({
    path: [...object.path],
    columns: PREFIX_COLUMNS,
    indexes: [],
    foreignKeys: [],
  });
  if (limit !== undefined && listed.length > limit) {
    return {
      details: listed.slice(0, limit).map(detail),
      truncated: { limit, reason: callerBoundTruncationReason(limit) },
    };
  }
  return { details: listed.map(detail) };
}

/** A structure part (spec 4.4, E16): JSON by `JSON.stringify`, cut at the caller's bound through the shared helper. */
function jsonPart(
  id: string,
  label: string,
  value: unknown,
  limit: number | undefined,
  edit?: ObjectPartEdit,
): ObjectSourcePart {
  const bounded = applySourceBound(JSON.stringify(value, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
    ...(edit === undefined ? {} : { edit }),
  };
}

function byteCount(n: number): string {
  return `${count(n)} byte${n === 1 ? "" : "s"}`;
}

/** Part 1's refusal (spec 4.4, E9): a withheld value's label, or that the value is empty or whitespace only. */
function unshownValue(view: ValueView): string | undefined {
  if (view.encoding === "withheld") return view.text;
  if (view.byteLength === 0) return "The value is empty (0 bytes).";
  if (view.encoding === "text" && view.text.trim() === "") {
    return `The value holds only whitespace (${byteCount(view.byteLength)}).`;
  }
  return undefined;
}

/**
 * Whether the value part may be edited, as the connected provider answers it (spec 4.4, 4.5), in 4.5's
 * order: E6, then E8's prefix and key half as the edit's put would meet them, then a value that is not
 * UTF-8, then a key outside the writable union (4.7). A withheld, empty or whitespace-only value never
 * reaches here, because its part is a refusal and carries no text to edit.
 */
function valueEdit(key: EtcdBytes, view: ValueView, context: EtcdSurfaceContext): ObjectPartEdit {
  const policy = refuseBeforeSend(
    assessCommand({ kind: "put", key, value: new Uint8Array(0), prevKv: false, ignoreValue: false, ignoreLease: true }),
    { readOnly: context.readOnly },
  );
  if (policy !== undefined) return { offered: false, reason: policy.message };
  if (view.encoding === "base64") return { offered: false, reason: VALUE_NOT_TEXT };
  if (!rangeCovered({ key }, context.writable)) {
    return { offered: false, reason: `etcd user ${scopedUser(context)} may read this key but not write it` };
  }
  return { offered: true };
}

/**
 * The key a path names, refused before any request unless its text reads back as exactly those bytes,
 * in the words the value edit's build refuses the same path with (spec 4.5).
 */
function exactKey(text: string): EtcdBytes {
  if (text === "") throw new QueryError('An etcd key is never empty: etcd answers "key is not provided".', PROVIDER);
  const key = encodeKey(text);
  if (decodeUtf8(key) !== text) {
    throw new QueryError(
      "This key is not UTF-8 text, so it names no stored key: a key that is not UTF-8 is read and written with a typed command.",
      PROVIDER,
    );
  }
  return key;
}

function valuePart(
  key: EtcdBytes,
  view: ValueView,
  context: EtcdSurfaceContext,
  limit: number | undefined,
): ObjectSourcePart {
  const unshown = unshownValue(view);
  if (unshown !== undefined) return { id: "value", label: "Value", unavailable: unshown };
  const bounded = applySourceBound(view.text, limit);
  return {
    id: "value",
    label: "Value",
    text: bounded.text,
    // R13 D11: a value that is not JSON is shown as plain text, never drawn with JSON diagnostics.
    language: view.encoding === "json" || view.encoding === "kubernetes-json" ? "json" : "plaintext",
    form: "complete",
    // The stored bytes as text, or this provider's base64 of bytes that are not text.
    origin: view.encoding === "base64" || view.encoding === "kubernetes-cbor" ? "rendered" : "stored",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
    edit: valueEdit(key, view, context),
  };
}

type LeaseTtl = { readonly granted: EtcdInt64; readonly remaining: EtcdInt64 } | "expired" | undefined;

/** The lease's TTL for the key's metadata: etcd checks no grant when the keys are not asked for (spec 4.4). */
async function keyLeaseTtl(client: EtcdObjectClient, context: EtcdSurfaceContext, kv: EtcdKeyValue): Promise<LeaseTtl> {
  if (kv.lease === "0") return undefined;
  const answer = await surfaceRead(
    () => client.leaseTimeToLive(kv.lease, false, { signal: context.signal }),
    context,
    "lease timetolive",
  );
  return answer.ttl === "-1" ? "expired" : { granted: answer.grantedTtl, remaining: answer.ttl };
}

function metadataPart(
  text: string,
  kv: EtcdKeyValue,
  view: ValueView,
  ttl: LeaseTtl,
  limit: number | undefined,
): ObjectSourcePart {
  return jsonPart(
    "metadata",
    ttl === "expired" ? "Metadata (the lease expired after the key was read)" : "Metadata",
    {
      key: text,
      create_revision: kv.createRevision,
      mod_revision: kv.modRevision,
      version: kv.version,
      lease: kv.lease === "0" ? null : leaseHexId(kv.lease),
      ...(ttl === undefined || ttl === "expired"
        ? {}
        : { lease_granted_ttl: ttl.granted, lease_remaining_ttl: ttl.remaining }),
      value_encoding: view.encoding,
      value_bytes: view.byteLength,
    },
    limit,
    { offered: false, reason: METADATA_NOT_EDITED },
  );
}

async function keySource(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  path: readonly string[],
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const text = path[0];
  const key = exactKey(text);
  // The key as a person types it back (keys.ts `typedKey`), the one way every sentence names a key (spec 5.5, 5.6).
  const shown = typedKey(key, "command-line");
  const answer = await surfaceRead(
    () => client.range({ key, limit: 1 }, { signal: context.signal }),
    context,
    "get",
    shown,
  );
  const kv: EtcdKeyValue | undefined = answer.kvs[0];
  if (kv === undefined) throw new QueryError(`etcd holds no key ${shown}`, PROVIDER);
  // The Source tab applies the caller's bound, so the cell bound of 5.4 plays no part here.
  const view = viewValue(kv.key, kv.value, Number.POSITIVE_INFINITY);
  const ttl = await keyLeaseTtl(client, context, kv);
  return {
    path: [...path],
    kind: "key",
    parts: [valuePart(kv.key, view, context, limit), metadataPart(text, kv, view, ttl, limit)],
  };
}

function statusPart(status: EtcdStatus, limit: number | undefined): ObjectSourcePart {
  return jsonPart(
    "status",
    "Status (the member this connection reaches)",
    {
      version: status.version,
      dbSize: status.dbSize,
      dbSizeInUse: status.dbSizeInUse,
      dbSizeQuota: status.dbSizeQuota,
      leader: status.leader === status.header.memberId,
      raftTerm: status.raftTerm,
      raftIndex: status.raftIndex,
      raftAppliedIndex: status.raftAppliedIndex,
      errors: status.errors,
      storageVersion: status.storageVersion,
    },
    limit,
  );
}

/** Another member's status is never read (spec 4.4, E3): the part names the member this connection reaches. */
function statusElsewhere(answering: EtcdInt64, members: readonly EtcdMember[]): ObjectSourcePart {
  const reached = members.find((member) => member.id === answering);
  return {
    id: "status",
    label: "Status",
    unavailable: `etcd reports a member's status only to a connection that reaches it, and this connection reaches ${reached === undefined ? memberHexId(answering) : memberLabel(reached)}: connect to this member to read its status.`,
  };
}

async function memberSource(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  path: readonly string[],
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const text = path[0];
  const id = fromHexId(text);
  if (id === undefined) {
    throw new QueryError(
      `${JSON.stringify(text)} is not an etcd member id: a member id is hex, as member list prints it.`,
      PROVIDER,
    );
  }
  const options = { signal: context.signal };
  const listed = await surfaceRead(() => client.memberList({ linearizable: false }, options), context, "member list");
  const member = listed.members.find((candidate) => candidate.id === id);
  if (member === undefined) throw new QueryError(`etcd has no member ${text}`, PROVIDER);
  const first = jsonPart(
    "member",
    "Member",
    {
      id: memberHexId(member.id),
      name: member.name,
      peerURLs: member.peerUrls,
      clientURLs: member.clientUrls,
      isLearner: member.isLearner,
    },
    limit,
  );
  if (listed.header.memberId !== member.id) {
    return { path: [...path], kind: "member", parts: [first, statusElsewhere(listed.header.memberId, listed.members)] };
  }
  const status = await surfaceRead(() => client.status(options), context, "endpoint status");
  return {
    path: [...path],
    kind: "member",
    parts: [
      first,
      status.header.memberId === member.id
        ? statusPart(status, limit)
        : statusElsewhere(status.header.memberId, listed.members),
    ],
  };
}

/** A key as a source lists it: its text, or base64 marked as such when it is not UTF-8 (spec 5.2's key_encoding). */
function keyEntry(key: EtcdBytes): { readonly key: string; readonly key_encoding?: "base64" } {
  const view = viewKey(key);
  return view.encoding === "text" ? { key: view.text } : { key: view.text, key_encoding: "base64" };
}

/**
 * A negative lease id as lease list prints it (keys.ts `leaseHexId`), a sign and then hex digits: the
 * listing leaves it out, and the Source tab refuses it in the command grammar's words (commands.ts
 * `NEGATIVE_LEASE`).
 */
const NEGATIVE_LEASE_ID = /^-[0-9a-fA-F]+$/;
const HEX_LEASE_ID = /^[0-9a-fA-F]+$/;
/** The largest lease id as lease list prints it, derived from the int64 bound keys.ts states once (commands.ts reads it the same way). */
const LARGEST_LEASE_ID = INT64_MAX.toString(16);

/**
 * A hex path past the largest int64, in any padding, which keys.ts `fromHexId` reads as a uint64 or refuses
 * as past 64 bits: a lease id is an int64, so it is refused before any request, in the words the command
 * grammar refuses `--lease` with (commands.ts `leaseId`).
 */
function pastLargestLease(text: string): boolean {
  return HEX_LEASE_ID.test(text) && BigInt(`0x${text}`) > INT64_MAX;
}

async function leaseSource(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  path: readonly string[],
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const text = path[0];
  if (NEGATIVE_LEASE_ID.test(text)) {
    throw new QueryError(
      `${JSON.stringify(text)} is a negative lease id, as lease list prints one: Studio does not address a negative id, which etcd holds only when a client chose it.`,
      PROVIDER,
    );
  }
  if (pastLargestLease(text)) {
    throw new QueryError(`${JSON.stringify(text)} is past the largest lease id, ${LARGEST_LEASE_ID}.`, PROVIDER);
  }
  const id = fromHexId(text);
  if (id === undefined) {
    throw new QueryError(
      `${JSON.stringify(text)} is not an etcd lease id: a lease id is hex, as lease list prints it.`,
      PROVIDER,
    );
  }
  const options = { signal: context.signal };
  let answer: EtcdLeaseTimeToLiveResponse;
  let refusedKeys: ObjectSourcePart | undefined;
  try {
    answer = await client.leaseTimeToLive(id, true, options);
  } catch (error) {
    if (!(error instanceof EtcdError) || error.category !== "permission-denied") {
      throw toProviderError(error, surfaceErrorContext(context, "lease timetolive"));
    }
    // etcd checks READ on every attached key only when the keys are asked for, so the TTL is read without them.
    answer = await surfaceRead(() => client.leaseTimeToLive(id, false, options), context, "lease timetolive");
    refusedKeys = {
      id: "keys",
      label: "Attached keys",
      unavailable: `The keys attached to this lease could not be read${etcdWords(error)}`,
    };
  }
  if (answer.ttl === "-1") throw leaseNotFoundError(text, "lease timetolive");
  return {
    path: [...path],
    kind: "lease",
    parts: [
      jsonPart("lease", "Lease", { id: leaseHexId(answer.id), TTL: answer.ttl, grantedTTL: answer.grantedTtl }, limit),
      refusedKeys ?? jsonPart("keys", "Attached keys", answer.keys.map(keyEntry), limit),
    ],
  };
}

/** etcd's answer for a user or role it does not hold, by code and message together (SRC `error.go`). */
function missing(error: unknown, answer: string): error is EtcdError {
  return error instanceof EtcdError && error.category === "failed-precondition" && error.detail === answer;
}

async function userSource(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  path: readonly string[],
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const name = path[0];
  let roles: readonly string[];
  try {
    roles = await client.userGet(name, { signal: context.signal });
  } catch (error) {
    if (missing(error, "etcdserver: user name not found")) {
      throw new QueryError(`etcd holds no user ${JSON.stringify(name)}${etcdWords(error)}`, PROVIDER);
    }
    throw toProviderError(error, surfaceErrorContext(context, "user get"));
  }
  return { path: [...path], kind: "user", parts: [jsonPart("user", "User", { name, roles }, limit)] };
}

/**
 * One grant as spec 4.4 lists it: READ when etcd omits the type, the bytes as text or base64, and `prefix`
 * only for an exact prefix range.
 */
function permissionEntry(permission: EtcdPermission): Record<string, unknown> {
  const key = keyEntry(permission.key);
  const end = permission.rangeEnd === undefined ? undefined : keyEntry(permission.rangeEnd);
  return {
    type: permission.type.toUpperCase(),
    ...key,
    range_end: end === undefined ? null : end.key,
    ...(end?.key_encoding === undefined ? {} : { range_end_encoding: end.key_encoding }),
    ...(rangeShape(permission).shape === "prefix" ? { prefix: true } : {}),
  };
}

async function roleSource(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  path: readonly string[],
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const name = path[0];
  let permissions: readonly EtcdPermission[];
  try {
    permissions = await client.roleGet(name, { signal: context.signal });
  } catch (error) {
    if (missing(error, "etcdserver: role name not found")) {
      throw new QueryError(`etcd holds no role ${JSON.stringify(name)}${etcdWords(error)}`, PROVIDER);
    }
    throw toProviderError(error, surfaceErrorContext(context, "role get"));
  }
  return {
    path: [...path],
    kind: "role",
    parts: [
      jsonPart(
        "role",
        // etcd lists no permission for root, which its auth store permits every key (permissions.ts ROOT_ROLE).
        name === ROOT_ROLE ? `Permissions (${ROOT_ROLE_HOLDS_EVERY_KEY})` : "Permissions",
        { name, permissions: permissions.map(permissionEntry) },
        limit,
      ),
    ],
  };
}

/** Spec 4.4's sources; an object that does not exist is a QueryError naming it, as the conformance helper requires. */
export async function readEtcdObjectSource(
  client: EtcdObjectClient,
  context: EtcdSurfaceContext,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  requireKindPath(path, kind);
  switch (kind) {
    case "key":
      return keySource(client, context, path, limit);
    case "member":
      return memberSource(client, context, path, limit);
    case "lease":
      return leaseSource(client, context, path, limit);
    case "user":
      return userSource(client, context, path, limit);
    case "role":
      return roleSource(client, context, path, limit);
    default:
      throw new QueryError(`etcd publishes no definition text for the kind "${kind}"`, PROVIDER);
  }
}
