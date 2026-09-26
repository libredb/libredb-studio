/**
 * The Kafka provider's I/O-free seam (spec 3.1).
 *
 * Every module above this line depends on `KafkaReadClient`, never on the client
 * library. The interface holds READ methods only: the read-only guarantee of spec
 * 3.6 K4 starts here, because a method that is not on this interface cannot be
 * called by provider logic at all. The one implementation is
 * `platformatic-client.ts`; tests implement it with recorded payloads.
 *
 * Offsets and timestamps are bigint: they are 64-bit on the wire, and a JavaScript
 * number loses precision past 2^53. They are written with `BigInt()` calls, never as
 * `0n` literals, because tsconfig targets ES2017, where a bigint literal is error TS2737.
 */

export type KafkaErrorCategory =
  | "invalid-request"
  | "invalid-config"
  | "unknown-topic"
  | "unknown-object"
  | "unreadable-topic"
  | "offset-out-of-range"
  | "authorization"
  | "authentication"
  | "tls"
  | "network"
  | "advertised-unreachable"
  | "timeout"
  | "unsupported-broker"
  | "protocol";

export interface KafkaErrorDetail {
  readonly apiId?: string;
  readonly resource?: string;
  readonly host?: string;
  readonly port?: number;
  readonly nodeCode?: string;
  readonly validRange?: { readonly earliest: bigint; readonly latest: bigint };
}

/** A domain failure; `errors.ts` maps each category to the product's error class. */
export class KafkaError extends Error {
  constructor(
    readonly category: KafkaErrorCategory,
    message: string,
    readonly detail: KafkaErrorDetail = {},
  ) {
    super(message);
    this.name = "KafkaError";
  }
}

/** What one read that one part of an answer rests on came to: its answer, or the broker's refusal of it in words. */
export type PartRead<T> = { readonly answer: T } | { readonly refused: string };

/**
 * A read one part of an answer rests on, with the broker's refusal of it as an answer: a refusal and
 * an absence are different answers (docs/ADDING_A_PROVIDER.md), so a principal the broker refuses one
 * read still sees the parts it may read, and the refused part says why (spec 4.4). Only the domain's
 * authorization refusal is one; any other failure, of another category or none, rejects as itself.
 */
export async function partRead<T>(read: () => Promise<T>): Promise<PartRead<T>> {
  try {
    return { answer: await read() };
  } catch (error) {
    if (error instanceof KafkaError && error.category === "authorization") return { refused: error.message };
    throw error;
  }
}

/** Shared bigint constants, so no module spells a literal (see the file header). */
export const BIGINT_ZERO = BigInt(0);
export const BIGINT_ONE = BigInt(1);

export interface KafkaBroker {
  readonly nodeId: number;
  readonly host: string;
  readonly port: number;
  readonly rack: string | null;
}

export interface KafkaPartitionMetadata {
  readonly partition: number;
  /** -1 when the partition has no leader (offline). */
  readonly leader: number;
  readonly leaderEpoch: number;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
  readonly offlineReplicas: readonly number[];
}

export interface KafkaTopicMetadata {
  readonly name: string;
  readonly id: string;
  readonly partitions: readonly KafkaPartitionMetadata[];
}

export interface KafkaClusterMetadata {
  readonly clusterId: string;
  readonly controllerId: number;
  /** The live brokers only: the Metadata response lists no broker that is down. */
  readonly brokers: readonly KafkaBroker[];
  readonly topics: readonly KafkaTopicMetadata[];
}

export interface KafkaRecord {
  readonly partition: number;
  readonly offset: bigint;
  /** Milliseconds since the epoch: the producer's time, or the broker's on a LogAppendTime topic. */
  readonly timestamp: bigint;
  readonly key: Uint8Array | null;
  readonly value: Uint8Array | null;
  readonly headers: ReadonlyArray<readonly [Uint8Array | null, Uint8Array | null]>;
}

export interface KafkaFetchResult {
  /** User records at or after the requested offset, in log order: transaction markers and aborted records are not among them. */
  readonly records: readonly KafkaRecord[];
  /**
   * The offset after the last batch the broker returned, control batches included,
   * so a read over a transactional or compacted log advances even when a batch
   * carries no user record. Equal to the requested offset when nothing came back.
   */
  readonly nextOffset: bigint;
}

export interface KafkaConfigEntry {
  readonly name: string;
  /** `null` when the broker withholds it (every `isSensitive` entry, measured M-C). */
  readonly value: string | null;
  readonly readOnly: boolean;
  readonly isSensitive: boolean;
  /** The protocol's ConfigSource number; 5 is DEFAULT_CONFIG. */
  readonly source: number;
}

export type KafkaGroupType = "classic" | "consumer";

export interface KafkaGroupListing {
  readonly groupId: string;
  readonly state: string;
  readonly groupType: KafkaGroupType;
  /** "consumer", or empty for a group that only commits offsets; the listing drops every other protocol type (spec 4.3). */
  readonly protocolType: string;
}

export interface KafkaGroupMember {
  readonly memberId: string;
  readonly clientId: string;
  readonly clientHost: string;
  readonly assignment: ReadonlyArray<{ readonly topic: string; readonly partitions: readonly number[] }>;
}

export interface KafkaGroupDescription {
  readonly groupId: string;
  readonly groupType: KafkaGroupType;
  readonly state: string;
  /** The classic protocol name, or the KIP-848 assignor name. */
  readonly protocolOrAssignor: string;
  readonly members: readonly KafkaGroupMember[];
}

export interface KafkaCommittedOffset {
  readonly topic: string;
  readonly partition: number;
  /** -1 when the group holds no committed offset for the partition. */
  readonly offset: bigint;
}

export interface KafkaLogDir {
  readonly brokerId: number;
  readonly path: string;
  readonly sizeBytes: bigint;
  /** -1 when the broker does not report it. */
  readonly totalBytes: bigint;
  readonly usableBytes: bigint;
}

/**
 * Where a read of offsets ends: "earliest" is the log start; "latest" is the last stable
 * offset, the end a read-committed fetch can reach; "high-watermark" is the log end, which
 * kafka-consumer-groups.sh measures lag against (spec 4.3).
 */
export type KafkaOffsetPosition = "earliest" | "latest" | "high-watermark";

export interface KafkaReadClient {
  /**
   * Metadata for the named topics, or for every non-internal topic when omitted. Never
   * creates a topic. An empty list reads the live brokers with a real round trip. A
   * partition with no leader answers `leader: -1`; an internal topic is refused.
   */
  metadata(topics?: readonly string[]): Promise<KafkaClusterMetadata>;
  /** Every non-internal topic name, sorted. */
  listTopics(): Promise<string[]>;
  /** Per-partition offsets at one position; an internal topic or one with a leaderless partition is refused. */
  offsets(topic: string, at: KafkaOffsetPosition): Promise<Map<number, bigint>>;
  /** Per-partition first offset at or after the timestamp; -1 past the log end. */
  offsetsForTimestamp(topic: string, timestampMs: bigint): Promise<Map<number, bigint>>;
  /** One fetch from the partition's leader, following a leader that moved once. */
  fetch(topic: KafkaTopicMetadata, partition: number, offset: bigint, signal: AbortSignal): Promise<KafkaFetchResult>;
  topicConfigs(topic: string): Promise<KafkaConfigEntry[]>;
  brokerConfigs(nodeId: number): Promise<KafkaConfigEntry[]>;
  /** Consumer groups of both protocols; `listGroups()` without a type filter omits KIP-848 groups (M-E). */
  listGroups(): Promise<KafkaGroupListing[]>;
  /** Dispatched on the listing's groupType (spec 4.3). */
  describeGroup(listing: KafkaGroupListing): Promise<KafkaGroupDescription>;
  committedOffsets(groupId: string): Promise<KafkaCommittedOffset[]>;
  logDirs(topics: readonly KafkaTopicMetadata[]): Promise<KafkaLogDir[]>;
  close(): Promise<void>;
}
