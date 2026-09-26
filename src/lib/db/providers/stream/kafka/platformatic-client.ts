/**
 * The only file that imports @platformatic/kafka (spec 3.1, 3.6 K4).
 *
 * It calls read methods only, from the allowlist the seam guard enforces. It never
 * calls consume(): measured M-D, MANUAL-mode consume() joins the consumer group even
 * with explicit offsets and autocommit off. A read's records come from the adapter's own
 * Fetch v13, sent through the library's exported protocol module on a connection from the
 * library's pool, which names no group at all (spec 3.6 K8); the Consumer serves offsets
 * only, and the groupId its constructor requires is a sentinel that is never sent (M-A).
 *
 * The library is injected (`lib`), so tests replace it with recorded payloads and the
 * provider loads the real one through `loadPlatformatic()`.
 */
import { isIP } from "node:net";
import {
  BIGINT_ONE,
  BIGINT_ZERO,
  type KafkaBroker,
  type KafkaClusterMetadata,
  type KafkaCommittedOffset,
  type KafkaConfigEntry,
  KafkaError,
  type KafkaFetchResult,
  type KafkaGroupDescription,
  type KafkaGroupListing,
  type KafkaGroupType,
  type KafkaLogDir,
  type KafkaReadClient,
  type KafkaRecord,
  type KafkaTopicMetadata,
} from "./client";
import type { KafkaConnectionOptions } from "./connection-options";

export const KAFKA_SENTINEL_GROUP_ID = "libredb-studio-never-joined";
const KAFKA_FETCH_MAX_WAIT_MS = 250;
const KAFKA_FETCH_MAX_BYTES = 1024 * 1024;

/* The library's shapes this file reads, narrowed to what it uses. The seam guard pins each member list. */
interface AdminLike {
  metadata(o: object): Promise<LibMetadata>;
  listTopics(o?: object): Promise<string[]>;
  describeConfigs(o: object): Promise<LibConfigResource[]>;
  listGroups(o: object): Promise<Map<string, { id: string; state: string; groupType?: string; protocolType: string }>>;
  describeGroups(o: object): Promise<Map<string, LibClassicGroup>>;
  listConsumerGroupOffsets(o: object): Promise<LibGroupOffsets[]>;
  describeLogDirs(o: object): Promise<LibBrokerLogDirs[]>;
  /** A bare array (dist/clients/admin/admin.d.ts:25), not an object with a coordinators key. */
  findCoordinator(o: object): Promise<Array<{ key: string; nodeId: number; host: string; port: number }>>;
  listApis(): Promise<Array<{ apiKey: number; name: string; minVersion: number; maxVersion: number }>>;
  close(): Promise<void>;
}
interface ConsumerLike {
  listOffsets(o: object): Promise<Map<string, bigint[]>>;
  listOffsetsWithTimestamps(o: object): Promise<Map<string, Map<number, { offset: bigint; timestamp: bigint }>>>;
  close(): Promise<void>;
}
interface ConnectionLike {
  connect(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}
/** One connection per broker address, opened on first use and dropped once closed (dist/network/connection-pool.js). */
interface ConnectionPoolLike {
  get(broker: { host: string; port: number }): Promise<ConnectionLike>;
  close(): Promise<void>;
}
/** One topic of a Fetch request and its partitions (dist/apis/consumer/fetch-v13.d.ts, FetchRequestTopic). */
interface LibFetchRequestTopic {
  topicId: string;
  partitions: Array<{
    partition: number;
    fetchOffset: bigint;
    partitionMaxBytes: number;
    currentLeaderEpoch: number;
    lastFetchedEpoch: number;
  }>;
}
interface LibMetadata {
  id: string;
  controllerId: number;
  brokers: Map<number, { host: string; port: number; rack: string | null }>;
  /** A requested internal topic answers undefined: the library's cache skips internal topics. */
  topics: Map<
    string,
    | {
        id: string;
        partitions: Array<{
          leader: number;
          leaderEpoch: number;
          replicas: number[];
          isr: number[];
          offlineReplicas: number[];
        }>;
      }
    | undefined
  >;
}
/** The raw Metadata v12 response a ResponseError carries (dist/apis/metadata/metadata-v12.d.ts). */
interface LibRawMetadata {
  brokers: Array<{ nodeId: number; host: string; port: number; rack: string | null }>;
  clusterId: string | null;
  controllerId: number;
  topics: Array<{
    name: string | null;
    topicId: string;
    isInternal: boolean;
    partitions: Array<{
      partitionIndex: number;
      leaderId: number;
      leaderEpoch: number;
      replicaNodes: number[];
      isrNodes: number[];
      offlineReplicas: number[];
    }>;
  }>;
}
interface LibConfigResource {
  resourceType: number;
  resourceName: string;
  configs: Array<{ name: string; value: string | null; readOnly: boolean; configSource: number; isSensitive: boolean }>;
}
interface LibClassicGroup {
  state: string;
  protocol: string;
  /** A member whose metadata the library could not read carries no assignments (dist/clients/admin/admin.js). */
  members: Map<
    string,
    { id: string; clientId: string; clientHost: string; assignments?: Map<string, { partitions: number[] }> }
  >;
}
interface LibGroupOffsets {
  groupId: string;
  topics: Array<{ name: string; partitions: Array<{ partitionIndex: number; committedOffset: bigint }> }>;
}
interface LibBrokerLogDirs {
  broker: number;
  results: Array<{
    logDir: string;
    totalBytes: bigint;
    usableBytes: bigint;
    topics: Array<{ partitions: Array<{ partitionSize: bigint }> }>;
  }>;
}
interface LibFetchResponse {
  responses: Array<{
    topicId: string;
    partitions: Array<{
      partitionIndex: number;
      abortedTransactions?: Array<{ producerId: bigint; firstOffset: bigint }> | null;
      records: Array<{
        firstOffset: bigint;
        lastOffsetDelta: number;
        firstTimestamp: bigint;
        maxTimestamp: bigint;
        attributes: number;
        producerId: bigint;
        records: Array<{
          offsetDelta: number;
          timestampDelta: bigint;
          key: Uint8Array | null;
          value: Uint8Array | null;
          headers: Array<[Uint8Array | null, Uint8Array | null]>;
        }>;
      }> | null;
    }>;
  }>;
}
interface LibGroupDescribeResponse {
  groups: Array<{
    errorCode: number;
    errorMessage: string | null;
    groupId: string;
    groupState: string;
    assignorName: string;
    members: Array<{
      memberId: string;
      clientId: string;
      clientHost: string;
      assignment: { topicPartitions: Array<{ topicName: string; partitions: number[] }> };
    }>;
  }>;
}

export interface PlatformaticLib {
  readonly Admin: new (options: object) => AdminLike;
  readonly Consumer: new (options: object) => ConsumerLike;
  readonly Connection: new (clientId: string, options: object) => ConnectionLike;
  readonly ConnectionPool: new (clientId: string, options: object) => ConnectionPoolLike;
  readonly consumerGroupDescribeV0: {
    readonly api: {
      readonly async: (
        connection: ConnectionLike,
        groupIds: string[],
        includeAuthorizedOperations: boolean,
      ) => Promise<unknown>;
    };
  };
  readonly fetchV13: {
    readonly api: {
      readonly async: (
        connection: ConnectionLike,
        maxWaitMs: number,
        minBytes: number,
        maxBytes: number,
        isolationLevel: number,
        sessionId: number,
        sessionEpoch: number,
        topics: LibFetchRequestTopic[],
        forgottenTopicsData: never[],
        rackId: string,
      ) => Promise<LibFetchResponse>;
    };
  };
}

/**
 * Loads the library once for the process and hands over the six members this file uses.
 * `load` is the dynamic import; a test passes its own module in its place.
 */
export async function loadPlatformatic(
  load: () => Promise<typeof import("@platformatic/kafka")> = () => import("@platformatic/kafka"),
): Promise<PlatformaticLib> {
  const lib = await load();
  // The protocol logger prints the first bytes of every request frame when DEBUG names it
  // (plt:kafka:protocol, or DEBUG=*), and a SASL PLAIN frame carries the password (spec K3).
  // Muted once, for the process: the provider never needs it. A library that renamed it would
  // leave the frames printed, so its absence is refused rather than stepped over.
  const protocolLog = lib.loggers.protocol;
  if (protocolLog === undefined)
    throw new Error("@platformatic/kafka no longer exports loggers.protocol; re-check spec 3.6 K3");
  protocolLog.enabled = false;
  return {
    Admin: lib.Admin as never,
    Consumer: lib.Consumer as never,
    Connection: lib.Connection as never,
    ConnectionPool: lib.ConnectionPool as never,
    consumerGroupDescribeV0: lib.consumerGroupDescribeV0 as never,
    fetchV13: lib.fetchV13 as never,
  };
}

/** ConfigResourceTypes in the protocol. */
const TOPIC_RESOURCE = 2;
const BROKER_RESOURCE = 4;
/** FindCoordinatorKeyTypes.GROUP. */
const GROUP_KEY = 0;
/** ListOffsets' earliest and latest sentinels, and FetchIsolationLevels (dist/apis/enumerations.js). */
const EARLIEST_TIMESTAMP = BigInt(-2);
const LATEST_TIMESTAMP = BigInt(-1);
const READ_UNCOMMITTED = 0;
const READ_COMMITTED = 1;
/**
 * The Fetch API, and the one version this adapter sends: the first that names a topic by id
 * (KIP-516), which every broker from Apache Kafka 3.1 on answers, and where Redpanda v26.2.2 stops.
 */
const FETCH_API_KEY = 1;
const FETCH_VERSION = 13;
/** Session id 0 with epoch -1 asks for a full answer and opens no fetch session (KIP-227). */
const SESSIONLESS_ID = 0;
const SESSIONLESS_EPOCH = -1;
/** The broker answers once it holds a byte, as the library's own fetch asks (dist/clients/consumer/options.js). */
const KAFKA_FETCH_MIN_BYTES = 1;

/** Protocol errors a leaderless partition answers Metadata with (Kafka's KRaftMetadataCache). */
const LEADERLESS = new Set(["LEADER_NOT_AVAILABLE", "LISTENER_NOT_FOUND"]);
const PARTITION_PATH = /^\/topics\/\d+\/partitions\/\d+$/;
/** Protocol errors that say the fetched partition's leader is not where the metadata said. */
const STALE_LEADER = new Set(["NOT_LEADER_OR_FOLLOWER", "LEADER_NOT_AVAILABLE", "UNKNOWN_TOPIC_OR_PARTITION"]);
/** How often the client retries a failed request, so each request is sent at most twice. */
const RETRIES = 1;

export function createPlatformaticClient(options: KafkaConnectionOptions, lib: PlatformaticLib): KafkaReadClient {
  const transport = {
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.sasl === undefined ? {} : { sasl: options.sasl }),
    connectTimeout: options.timeoutMs,
    requestTimeout: options.timeoutMs,
  };
  let serverName = options.tlsServerName === true;
  const build = () => {
    const connections = { ...transport, ...(serverName ? { tlsServerName: true } : {}) };
    const base = {
      clientId: options.clientId,
      bootstrapBrokers: [{ host: options.broker.host, port: options.broker.port }],
      autocreateTopics: false,
      retries: RETRIES,
      ...connections,
    };
    return {
      admin: new lib.Admin(base),
      // groupProtocol is pinned rather than left to the library default: Consumer.close()
      // leaves a KIP-848 group with a heartbeat whenever the protocol is "consumer", joined
      // or not (dist/clients/consumer/consumer.js:134-139).
      consumer: new lib.Consumer({
        ...base,
        groupId: KAFKA_SENTINEL_GROUP_ID,
        autocommit: false,
        groupProtocol: "classic",
      }),
      // The connections a read's fetches go out on, one per broker address, with the clients' transport.
      fetchPool: new lib.ConnectionPool(options.clientId, connections),
    };
  };
  let { admin, consumer, fetchPool } = build();

  // The library applies one server-name rule to every broker connection, and an IP literal
  // is not a legal server name (Node 26 throws on one). So a cluster that advertises any
  // broker by IP gets both clients and the fetch pool rebuilt without SNI; such a cluster is
  // not routed by server name anyway (spec 6.1). Every broker list the adapter reads passes
  // here, connect()'s first and a fetch's own, before a connection reaches that broker.
  const dropServerNameForIpBrokers = async (brokers: readonly KafkaBroker[]) => {
    if (!serverName || brokers.every((b) => isIP(b.host) === 0)) return;
    serverName = false;
    const previous = [admin, consumer, fetchPool];
    ({ admin, consumer, fetchPool } = build());
    await Promise.all(previous.map((client) => client.close()));
  };

  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      // A domain error is already this provider's sentence. An error from anything but the
      // library is a defect here, and surfaces as itself rather than as a broker refusal.
      if (error instanceof KafkaError || !isLibraryFailure(error)) throw error;
      throw translateError(error, options.broker);
    }
  };

  const readMetadata = async (names: readonly string[]): Promise<KafkaClusterMetadata> => {
    refuseInternalTopics(names);
    // A copy, because the library sorts the array it is given in place (dist/clients/base/base.js,
    // the deduplication key), and the caller's list is the caller's. An empty list reads brokers
    // only, which the library would answer from its cache with no round trip: forced, so connect
    // and health reach the broker.
    const request = {
      topics: [...names],
      autocreateTopics: false,
      ...(names.length === 0 ? { forceUpdate: true } : {}),
    };
    let metadata: KafkaClusterMetadata;
    try {
      metadata = mapMetadata(await admin.metadata(request));
    } catch (error) {
      if (leaderlessResponse(error) === undefined) throw error;
      // The library fetched only the topics it held no fresh copy of, and caches no answer it
      // threw on: ask for every named topic again, so the carried response names them all.
      metadata = await admin.metadata({ ...request, forceUpdate: true }).then(mapMetadata, (forced: unknown) => {
        const raw = leaderlessResponse(forced);
        if (raw === undefined) throw forced;
        return mapRawMetadata(raw, names);
      });
    }
    await dropServerNameForIpBrokers(metadata.brokers);
    return metadata;
  };

  /**
   * The client's listOffsets reads a topic whole, and hangs on an internal one: refused first, with
   * the reason (spec 4.1), by name in readMetadata and, for a topic the broker marks internal that
   * Kafka's list does not hold, by the answer. The metadata answers exactly the topics asked for, on
   * both paths.
   */
  const readableTopic = async (topic: string): Promise<void> => {
    const leaderless = (await readMetadata([topic])).topics.flatMap((t) =>
      t.partitions.filter((p) => p.leader < 0).map((p) => p.partition),
    );
    if (leaderless.length > 0) {
      throw new KafkaError(
        "unreadable-topic",
        `Topic ${JSON.stringify(topic)} has no leader for partition ${leaderless.join(", ")}, and the client reads a topic's offsets as a whole`,
      );
    }
  };

  /**
   * Every topic name but the internal ones; a leaderless partition anywhere is read through, as
   * metadata is. The library leaves out only what the broker marks internal, and a broker before
   * Apache Kafka 3.9 marks no __share_group_state, which a user may create there and it then lists as
   * ordinary (measured on 3.8.0), so Kafka's set is left out by name too (spec 4.1): listed, the name
   * would meet the refusal by name at the metadata read that follows every listing.
   */
  const readTopicNames = async (): Promise<string[]> => {
    let names: string[];
    try {
      names = await admin.listTopics();
    } catch (error) {
      const raw = leaderlessResponse(error);
      if (raw === undefined) throw error;
      names = raw.topics.filter((t) => !t.isInternal).map(namedTopic);
    }
    return names.filter((name) => !INTERNAL_TOPICS.has(name)).sort();
  };

  const readConfigs = async (resourceType: number, resourceName: string): Promise<KafkaConfigEntry[]> =>
    mapConfigs(await admin.describeConfigs(configRequest(resourceType, resourceName)), resourceType, resourceName);

  let fetchVersionChecked = false;
  const requireFetchVersion = async (): Promise<void> => {
    if (fetchVersionChecked) return;
    const fetchApi = (await admin.listApis()).find((api) => api.apiKey === FETCH_API_KEY);
    if (fetchApi === undefined || fetchApi.minVersion > FETCH_VERSION || fetchApi.maxVersion < FETCH_VERSION) {
      const range =
        fetchApi === undefined ? "no Fetch version" : `Fetch versions ${fetchApi.minVersion} to ${fetchApi.maxVersion}`;
      throw new KafkaError(
        "unsupported-broker",
        `This broker answers ${range}; a read sends Fetch ${FETCH_VERSION}, which Apache Kafka answers from 3.1 on`,
      );
    }
    fetchVersionChecked = true;
  };

  /**
   * The brokers the cluster lists, from the library's copy when it holds one: a brokers-only read
   * the library answers from its cache without a round trip, where the provider's own metadata([])
   * is forced. A fetch reads its leader's advertised address here.
   */
  const listedBrokers = async (): Promise<readonly KafkaBroker[]> => {
    const { brokers } = mapMetadata(await admin.metadata({ topics: [], autocreateTopics: false }));
    await dropServerNameForIpBrokers(brokers);
    return brokers;
  };

  // A read's fetch is the adapter's own, never the library's Consumer.fetch (spec 3.6 K8). That
  // one hands every READ_COMMITTED answer to a filter that reads a control batch's first record
  // and an aborted range's end unguarded, inside the socket handler, where a throw is uncaught:
  // an answer holding an empty control batch (which Kafka's log cleaner keeps of a producer's last
  // marker), or an unlisted producer's ABORT marker, beside a listed aborted transaction left that
  // fetch unsettled, and ended a Node process that handles no uncaught exception (measured on Kafka
  // 4.3.1 after log cleaning, 2026-09-25). It also keeps one KIP-227 fetch session per broker, which
  // two reads in flight at once collide on. So a fetch here is Fetch v13, READ_COMMITTED and
  // sessionless, on a pooled connection to the leader: the library parses the answer inside its
  // own try and settles the call either way, no session exists to collide on, so overlapping reads
  // run side by side, and the answer reaches only mapFetch, which applies the Java consumer's rule.
  // A read stopped before its fetch is sent sends none.
  const fetchFrom = async (
    broker: KafkaBroker,
    topic: KafkaTopicMetadata,
    partition: number,
    offset: bigint,
    signal: AbortSignal,
  ): Promise<LibFetchResponse> => {
    const connection = await fetchPool.get({ host: broker.host, port: broker.port });
    if (signal.aborted) throw stoppedRead();
    const partitions = [
      {
        partition,
        fetchOffset: offset,
        partitionMaxBytes: KAFKA_FETCH_MAX_BYTES,
        currentLeaderEpoch: -1,
        lastFetchedEpoch: -1,
      },
    ];
    const answer = lib.fetchV13.api.async(
      connection,
      KAFKA_FETCH_MAX_WAIT_MS,
      KAFKA_FETCH_MIN_BYTES,
      KAFKA_FETCH_MAX_BYTES,
      READ_COMMITTED,
      SESSIONLESS_ID,
      SESSIONLESS_EPOCH,
      [{ topicId: topic.id, partitions }],
      [],
      "",
    );
    // The library's parser rejects an answer it cannot read with the error that stopped it, such as
    // zlib's for a batch that will not decompress, which bears no PLT_KFK_ code; it is still the
    // broker's answer failing, never a defect of this provider's.
    return answer.catch((error: unknown) => {
      throw isLibraryFailure(error) ? error : translateError(error, options.broker);
    });
  };

  return {
    metadata: (topics) => guard(async () => readMetadata(topics ?? (await readTopicNames()))),

    listTopics: () => guard(readTopicNames),

    offsets: (topic, at) =>
      guard(async () => {
        await readableTopic(topic);
        const answer = await consumer.listOffsets({
          topics: [topic],
          timestamp: at === "earliest" ? EARLIEST_TIMESTAMP : LATEST_TIMESTAMP,
          // "latest" is the last stable offset, what a read-committed fetch can reach; the high
          // watermark is the log end, which kafka-consumer-groups.sh measures lag against.
          isolationLevel: at === "high-watermark" ? READ_UNCOMMITTED : READ_COMMITTED,
        });
        // The library answers an array indexed by partition. A partition it did not answer is a
        // hole, left out here rather than read as an offset (spec 4.1).
        const offsets = new Map<number, bigint>();
        answer.get(topic)?.forEach((offset, partition) => offsets.set(partition, offset));
        return offsets;
      }),

    offsetsForTimestamp: (topic, timestampMs) =>
      guard(async () => {
        await readableTopic(topic);
        const answer = await consumer.listOffsetsWithTimestamps({
          topics: [topic],
          timestamp: timestampMs,
          isolationLevel: READ_COMMITTED,
        });
        const offsets = new Map<number, bigint>();
        answer.get(topic)?.forEach(({ offset }, partition) => offsets.set(partition, offset));
        return offsets;
      }),

    // Each step waits on the read's signal as well, so a stopped read is answered at once, whatever
    // it waited on, and sends no fetch; what it waited on settles on its own, under the client's timers.
    fetch: (topic, partition, offset, signal) =>
      guard(async () => {
        // The forced re-read of a moved leader below names the topic in a Metadata request.
        refuseInternalTopics([topic.name]);
        if (signal.aborted) throw stoppedRead();
        const leader = leaderOf(topic, partition);
        await abortable(requireFetchVersion(), signal);
        // Metadata lists live brokers only, so a leader it names no broker for is down or gone:
        // no fetch is sent to it, and it is looked for again below, as a refused fetch is.
        const listed = (await abortable(listedBrokers(), signal)).find((b) => b.nodeId === leader);
        let refusal: unknown;
        if (listed !== undefined) {
          try {
            return mapFetch(
              await abortable(fetchFrom(listed, topic, partition, offset, signal), signal),
              topic,
              partition,
              offset,
            );
          } catch (error) {
            if (!staleLeader(error)) throw error;
            refusal = error;
          }
        }
        // A leader that moved (a rolling restart, a reassignment) refuses the fetch or cannot be
        // reached. The leader is read again, once, forced, and followed to a broker the answer lists.
        const fresh = mapMetadata(
          await abortable(admin.metadata({ topics: [topic.name], autocreateTopics: false, forceUpdate: true }), signal),
        );
        await dropServerNameForIpBrokers(fresh.brokers);
        const moved = fresh.topics.find((t) => t.name === topic.name);
        const movedTo = moved?.partitions.find((p) => p.partition === partition)?.leader ?? -1;
        const broker = movedTo === leader ? undefined : fresh.brokers.find((b) => b.nodeId === movedTo);
        if (moved === undefined || broker === undefined) throw refusal ?? unlistedLeader(topic.name, partition, leader);
        return mapFetch(
          await abortable(fetchFrom(broker, moved, partition, offset, signal), signal),
          moved,
          partition,
          offset,
        );
      }),

    topicConfigs: (topic) =>
      guard(async () => {
        refuseInternalTopics([topic]);
        return readConfigs(TOPIC_RESOURCE, topic);
      }),

    brokerConfigs: (nodeId) => guard(() => readConfigs(BROKER_RESOURCE, String(nodeId))),

    listGroups: () =>
      guard(async () => {
        const groups = await admin.listGroups({ types: ["consumer", "classic"] });
        return [...groups.values()]
          .flatMap((g): KafkaGroupListing[] => {
            const groupType = consumerGroupType(g);
            return groupType === undefined
              ? []
              : [{ groupId: g.id, state: g.state, groupType, protocolType: g.protocolType }];
          })
          .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
      }),

    describeGroup: (listing) =>
      guard(() =>
        listing.groupType === "classic"
          ? describeClassic(admin, listing)
          : describeConsumerProtocol(admin, lib, options, transport, listing),
      ),

    committedOffsets: (groupId) =>
      guard(async () => {
        const entry = (await admin.listConsumerGroupOffsets({ groups: [groupId] })).find((g) => g.groupId === groupId);
        // The broker answers an entry for every group asked for, even one that does not exist (M-E).
        if (entry === undefined)
          throw new KafkaError(
            "protocol",
            `The broker's committed offsets hold no entry for group ${JSON.stringify(groupId)}`,
          );
        return entry.topics.flatMap((t) =>
          t.partitions.map(
            (p): KafkaCommittedOffset => ({ topic: t.name, partition: p.partitionIndex, offset: p.committedOffset }),
          ),
        );
      }),

    logDirs: (topics) =>
      guard(async () => {
        refuseInternalTopics(topics.map((t) => t.name));
        const answer = await admin.describeLogDirs({
          topics: topics.map((t) => ({ name: t.name, partitions: t.partitions.map((p) => p.partition) })),
        });
        return answer.flatMap((broker) =>
          broker.results.map(
            (dir): KafkaLogDir => ({
              brokerId: broker.broker,
              path: dir.logDir,
              sizeBytes: dir.topics.flatMap((t) => t.partitions).reduce((sum, p) => sum + p.partitionSize, BIGINT_ZERO),
              totalBytes: dir.totalBytes,
              usableBytes: dir.usableBytes,
            }),
          ),
        );
      }),

    close: async () => {
      await Promise.all([admin.close(), consumer.close(), fetchPool.close()]);
    },
  };
}

/**
 * No configurationKeys: the protocol reads a null list as every key. An empty list is not the
 * same on every broker: Redpanda v26.2.2 answers it with no configs at all, where Apache Kafka
 * 4.3.1 answers every one (measured against both fixtures on 2026-09-24).
 */
function configRequest(resourceType: number, resourceName: string): object {
  return {
    resources: [{ resourceType, resourceName }],
    includeSynonyms: false,
    includeDocumentation: false,
  };
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function internalTopic(name: string): KafkaError {
  return new KafkaError(
    "unreadable-topic",
    `Topic ${JSON.stringify(name)} is internal to Kafka, and the client this provider uses drops internal topics from its metadata, so it is not readable here`,
  );
}

/**
 * Kafka's internal topics: the set Apache Kafka's own Topic.isInternal reads
 * (org.apache.kafka.common.internals.Topic, INTERNAL_TOPICS in 4.3.1: the group metadata, the
 * transaction state and the share-group state topics), matched whole and by case, as Kafka does.
 */
const INTERNAL_TOPICS: ReadonlySet<string> = new Set([
  "__consumer_offsets",
  "__transaction_state",
  "__share_group_state",
]);

/**
 * Refuses an internal topic by name, before any request names it (spec 4.1, 4.5). A broker before
 * Apache Kafka 2.8 creates a missing internal topic for any Metadata request that names it, whatever
 * allowAutoTopicCreation and auto.create.topics.enable say (KafkaApis.getTopicMetadata in 2.7.2;
 * 2.8.0 answers UNKNOWN_TOPIC_OR_PARTITION instead), so refusing it once the answer comes back is too
 * late there. The answer's own mark stays the second guard, for a topic the broker marks internal
 * that this list does not hold.
 */
function refuseInternalTopics(names: readonly string[]): void {
  const internal = names.find((name) => INTERNAL_TOPICS.has(name));
  if (internal !== undefined) throw internalTopic(internal);
}

function mapMetadata(md: LibMetadata): KafkaClusterMetadata {
  const brokers: KafkaBroker[] = [...md.brokers.entries()]
    .map(([nodeId, b]) => ({ nodeId, host: b.host, port: b.port, rack: b.rack }))
    .sort((a, b) => a.nodeId - b.nodeId);
  const topics: KafkaTopicMetadata[] = [...md.topics.entries()]
    .map(([name, t]): KafkaTopicMetadata => {
      // The library's metadata cache skips internal topics and answers their names with
      // undefined (dist/clients/base/base.js:513-531); a missing topic fails before this as
      // "Unknown topic", so undefined here is an internal topic.
      if (t === undefined) throw internalTopic(name);
      return {
        name,
        id: t.id,
        partitions: t.partitions.map((p, partition) => ({
          partition,
          leader: p.leader,
          leaderEpoch: p.leaderEpoch,
          replicas: p.replicas,
          isr: p.isr,
          offlineReplicas: p.offlineReplicas,
        })),
      };
    })
    .sort(byName);
  return { clusterId: md.id, controllerId: md.controllerId, brokers, topics };
}

/**
 * The same mapping over the raw response a leaderless partition's error carries, for exactly
 * the topics asked for, as the library's own answer holds them: an internal one is refused in
 * the same words, and one the response does not hold is a protocol error, never left out.
 */
function mapRawMetadata(raw: LibRawMetadata, names: readonly string[]): KafkaClusterMetadata {
  const topics = names.map((name): KafkaTopicMetadata => {
    const t = raw.topics.find((candidate) => candidate.name === name);
    if (t === undefined)
      throw new KafkaError("protocol", `The broker's metadata holds no entry for topic ${JSON.stringify(name)}`);
    if (t.isInternal) throw internalTopic(name);
    return {
      name,
      id: t.topicId,
      partitions: [...t.partitions]
        .sort((a, b) => a.partitionIndex - b.partitionIndex)
        .map((p) => ({
          partition: p.partitionIndex,
          leader: p.leaderId,
          leaderEpoch: p.leaderEpoch,
          replicas: p.replicaNodes,
          isr: p.isrNodes,
          offlineReplicas: p.offlineReplicas,
        })),
    };
  });
  return {
    clusterId: raw.clusterId ?? "",
    controllerId: raw.controllerId,
    brokers: raw.brokers
      .map(({ nodeId, host, port, rack }) => ({ nodeId, host, port, rack }))
      .sort((a, b) => a.nodeId - b.nodeId),
    topics: topics.sort(byName),
  };
}

/** A listed topic's name; a listing asks by name, so a topic named by id alone is the broker's anomaly, never "". */
function namedTopic(topic: LibRawMetadata["topics"][number]): string {
  if (topic.name === null)
    throw new KafkaError("protocol", `The broker's topic listing names topic ${topic.topicId} by id alone`);
  return topic.name;
}

const isRawMetadata = (value: unknown): value is LibRawMetadata =>
  value !== null &&
  typeof value === "object" &&
  Array.isArray((value as LibRawMetadata).brokers) &&
  Array.isArray((value as LibRawMetadata).topics);

/**
 * The Metadata response a leaderless partition's error carries, or undefined when the
 * failure is anything else. The library throws a ResponseError on any partition error code
 * but keeps the whole response on it (dist/apis/metadata/metadata-v12.js). It is read through
 * only when every protocol error in the chain is a partition-level leader error, so an
 * unknown or unauthorized topic still fails.
 */
function leaderlessResponse(error: unknown): LibRawMetadata | undefined {
  const chain = [...walk(error)];
  const protocol = chain.filter((e) => typeof e.apiId === "string");
  if (
    protocol.length === 0 ||
    !protocol.every((e) => LEADERLESS.has(e.apiId as string) && PARTITION_PATH.test(String(e.path)))
  ) {
    return undefined;
  }
  return chain
    .map((e) => e.response)
    .filter(isRawMetadata)
    .at(-1);
}

/** A fetch that failed because the partition's leader is not where the metadata said, or cannot be reached there. */
function staleLeader(error: unknown): boolean {
  return [...walk(error)].some((e) => STALE_LEADER.has(String(e.apiId)) || e.code === "PLT_KFK_NETWORK");
}

/** A leader the cluster lists no broker for, which a forced re-read names again or names no other listed broker for. */
function unlistedLeader(topic: string, partition: number, leader: number): KafkaError {
  return new KafkaError(
    "protocol",
    `Partition ${partition} of topic ${JSON.stringify(topic)} is led by broker ${leader}, which the cluster does not list as live; its leadership is moving, run the read again`,
  );
}

/** The leader the topic's metadata names for the partition; a partition the topic does not have is the caller's to fix. */
function leaderOf(topic: KafkaTopicMetadata, partition: number): number {
  const found = topic.partitions.find((p) => p.partition === partition);
  if (found === undefined)
    throw new KafkaError("invalid-request", `Topic ${JSON.stringify(topic.name)} has no partition ${partition}`);
  return found.leader;
}

/**
 * The listing's consumer groups, by Kafka's own rule (ListGroupsOptions.forConsumerGroups()):
 * a KIP-848 group, or a classic group whose protocol type is "consumer" or empty. Connect
 * ("connect") and Schema Registry ("sr") coordinate through classic groups that are not
 * consumer groups: their member metadata is no consumer subscription, and the library's
 * describeGroups would fail decoding it (spec 4.3). A broker below ListGroups v5 (Redpanda
 * v26.2.2, Apache Kafka before 3.8) reports no type, which is read as classic.
 */
function consumerGroupType(group: { groupType?: string; protocolType: string }): KafkaGroupType | undefined {
  const type = group.groupType ?? "classic";
  if (type === "consumer") return "consumer";
  if (type !== "classic") return undefined;
  return group.protocolType === "consumer" || group.protocolType === "" ? "classic" : undefined;
}

/** Record batch attribute bits (Kafka's DefaultRecordBatch; dist/protocol/records.js). */
const LOG_APPEND_TIME = 0x08;
const TRANSACTIONAL_BATCH = 0x10;
const CONTROL_BATCH = 0x20;
/** A control record's key is an int16 version then an int16 type; type 0 is ABORT, 1 is COMMIT. */
const ABORT_MARKER = 0;

/**
 * One partition's fetch answer to records (spec 5.2, Review Focus 2).
 *
 * - The answer's entry is the one for the fetched topic id and partition, never the first by
 *   position, and an answer that holds no entry for the partition had nothing for it, which
 *   leaves the read where it was.
 * - A control batch carries one marker record, a transaction's COMMIT or ABORT. It is never a
 *   row, but its offsets still advance `nextOffset`. The broker sends markers with the records.
 * - Under READ_COMMITTED the broker lists the aborted transactions that overlap the response.
 *   A transactional batch of a producer inside one of them is dropped until that producer's
 *   ABORT marker: the Java consumer's rule, applied per response, because the broker lists an
 *   aborted transaction again in every response that overlaps it. This is the only filter an
 *   answer meets: the library's own drops aborted records only when the marker is in the same
 *   response, and throws on answers this rule reads (see fetchFrom), so it is never on the path.
 * - A LogAppendTime topic stamps the broker's time on the batch's maxTimestamp only, which is
 *   then every record's timestamp; the per-record deltas keep the producer's clock.
 */
function mapFetch(
  response: LibFetchResponse,
  topic: KafkaTopicMetadata,
  partition: number,
  requested: bigint,
): KafkaFetchResult {
  const answer = response.responses
    .filter((t) => t.topicId === topic.id)
    .flatMap((t) => t.partitions)
    .find((p) => p.partitionIndex === partition);
  const aborted = [...(answer?.abortedTransactions ?? [])].sort((a, b) =>
    a.firstOffset < b.firstOffset ? -1 : a.firstOffset > b.firstOffset ? 1 : 0,
  );
  const abortedProducers = new Set<bigint>();
  let nextAborted = 0;
  const records: KafkaRecord[] = [];
  let nextOffset = requested;
  for (const batch of answer?.records ?? []) {
    const lastOffset = batch.firstOffset + BigInt(batch.lastOffsetDelta);
    if (lastOffset + BIGINT_ONE > nextOffset) nextOffset = lastOffset + BIGINT_ONE;
    while (nextAborted < aborted.length && aborted[nextAborted].firstOffset <= lastOffset) {
      abortedProducers.add(aborted[nextAborted].producerId);
      nextAborted++;
    }
    if ((batch.attributes & CONTROL_BATCH) !== 0) {
      // An empty control batch, which the log cleaner keeps of a producer's last marker, marks
      // nothing, as the Java consumer's containsAbortMarker reads it.
      const [marker] = batch.records;
      if (marker !== undefined && controlType(marker.key, batch.firstOffset) === ABORT_MARKER) {
        abortedProducers.delete(batch.producerId);
      }
      continue;
    }
    if ((batch.attributes & TRANSACTIONAL_BATCH) !== 0 && abortedProducers.has(batch.producerId)) continue;
    const appendTime = (batch.attributes & LOG_APPEND_TIME) !== 0;
    for (const r of batch.records) {
      const offset = batch.firstOffset + BigInt(r.offsetDelta);
      if (offset < requested) continue;
      records.push({
        partition,
        offset,
        timestamp: appendTime ? batch.maxTimestamp : batch.firstTimestamp + r.timestampDelta,
        key: r.key,
        value: r.value,
        headers: r.headers,
      });
    }
  }
  return { records, nextOffset };
}

/**
 * A control record's type, read as the Java consumer's ControlRecordType.parse reads it: the key is
 * an int16 version, never negative, then the int16 type, and a version it does not know is read by
 * its type all the same. A key that is not that is the broker's anomaly, refused as Java refuses it,
 * never taken for "no marker", which would keep an aborted transaction's records or drop a
 * committed one's. A control batch holds its one record at the batch's first offset.
 */
function controlType(key: Uint8Array | null, offset: bigint): number {
  if (key === null || key.byteLength < 4) {
    throw new KafkaError(
      "protocol",
      `The broker sent a transaction marker at offset ${offset} whose key is not a control record's version and type`,
    );
  }
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  if (view.getInt16(0) < 0) {
    throw new KafkaError(
      "protocol",
      `The broker sent a transaction marker at offset ${offset} with a negative version, which the Java consumer refuses as corrupt`,
    );
  }
  return view.getInt16(2);
}

/** The answer's entry for the resource asked, never the first by position. */
function mapConfigs(resources: LibConfigResource[], resourceType: number, resourceName: string): KafkaConfigEntry[] {
  const entry = resources.find((r) => r.resourceType === resourceType && r.resourceName === resourceName);
  if (entry === undefined)
    throw new KafkaError("protocol", `The broker's configs hold no entry for ${JSON.stringify(resourceName)}`);
  return entry.configs
    .map((c) => ({
      name: c.name,
      value: c.value,
      readOnly: c.readOnly,
      isSensitive: c.isSensitive,
      source: c.configSource,
    }))
    .sort(byName);
}

async function describeClassic(admin: AdminLike, listing: KafkaGroupListing): Promise<KafkaGroupDescription> {
  // The listing already dropped every other protocol type; this pins the rule at the one call
  // it protects, because the library decodes each member's metadata as a consumer subscription.
  if (listing.protocolType !== "consumer" && listing.protocolType !== "") {
    throw new KafkaError(
      "unknown-object",
      `Group ${JSON.stringify(listing.groupId)} is a ${listing.protocolType} group, not a consumer group`,
    );
  }
  const group = (await admin.describeGroups({ groups: [listing.groupId] })).get(listing.groupId);
  // The broker describes every group asked for, a missing one as Dead (M-E), so no entry is its anomaly.
  if (group === undefined)
    throw new KafkaError(
      "protocol",
      `The broker's group description holds no entry for group ${JSON.stringify(listing.groupId)}`,
    );
  return {
    groupId: listing.groupId,
    groupType: "classic",
    state: group.state,
    protocolOrAssignor: group.protocol,
    members: [...group.members.values()].map((m) => ({
      memberId: m.id,
      clientId: m.clientId,
      clientHost: m.clientHost,
      assignment: [...(m.assignments?.entries() ?? [])].map(([topic, a]) => ({ topic, partitions: a.partitions })),
    })),
  };
}

/** KIP-848 groups are described only by ConsumerGroupDescribe, API 69 (measured M-F); the client has no Admin method for it. */
async function describeConsumerProtocol(
  admin: AdminLike,
  lib: PlatformaticLib,
  options: KafkaConnectionOptions,
  transport: object,
  listing: KafkaGroupListing,
): Promise<KafkaGroupDescription> {
  const coordinator = (await admin.findCoordinator({ keyType: GROUP_KEY, keys: [listing.groupId] })).find(
    (c) => c.key === listing.groupId,
  );
  if (coordinator === undefined)
    throw new KafkaError("protocol", `The broker named no coordinator for group ${JSON.stringify(listing.groupId)}`);
  // One connection, one host: the server name is decided for this host alone.
  const connection = new lib.Connection(options.clientId, {
    ...transport,
    ...(options.tls !== undefined && isIP(coordinator.host) === 0 ? { tlsServerName: true } : {}),
  });
  let response: LibGroupDescribeResponse;
  let refused: unknown;
  try {
    await connection.connect(coordinator.host, coordinator.port);
    try {
      response = (await lib.consumerGroupDescribeV0.api.async(
        connection,
        [listing.groupId],
        false,
      )) as LibGroupDescribeResponse;
    } catch (error) {
      // The client throws on any per-group error code but keeps the whole response (M-F), with one
      // protocol error per errored entry, on that entry's path.
      const carried = (error as { response?: LibGroupDescribeResponse }).response;
      if (carried === undefined) throw error;
      response = carried;
      refused = error;
    }
  } finally {
    await connection.close();
  }
  const index = response.groups.findIndex((g) => g.groupId === listing.groupId);
  // The broker answers an entry for every group asked for, so none is its anomaly: the listing, which
  // decides that the group exists (spec 4.3), named it.
  if (index < 0) {
    throw new KafkaError(
      "protocol",
      `The broker's consumer group description holds no entry for group ${JSON.stringify(listing.groupId)}`,
    );
  }
  const group = response.groups[index];
  if (group.errorCode !== 0) throw groupEntryRefusal(refused, index, group.errorCode, listing.groupId, options.broker);
  return {
    groupId: group.groupId,
    groupType: "consumer",
    state: group.groupState,
    protocolOrAssignor: group.assignorName,
    members: group.members.map((m) => ({
      memberId: m.memberId,
      clientId: m.clientId,
      clientHost: m.clientHost,
      assignment: m.assignment.topicPartitions.map((tp) => ({ topic: tp.topicName, partitions: tp.partitions })),
    })),
  };
}

/**
 * An API 69 entry's error, classified by its protocol error name through the error table (spec 5.6),
 * never by the text the broker wrote: the client throws one ProtocolError per errored entry, on that
 * entry's path (dist/apis/admin/consumer-group-describe-v0.js). A refusal of the group or of a topic it
 * uses is authorization, and a coordinator that moved or is loading is a protocol error naming it.
 * GROUP_ID_NOT_FOUND, which the broker answers for an id with no consumer-protocol group, is the one
 * the adapter words itself.
 */
function groupEntryRefusal(
  refused: unknown,
  index: number,
  errorCode: number,
  groupId: string,
  bootstrap: { host: string; port: number },
): KafkaError {
  const own = [...walk(refused)].find((e) => e.path === `/groups/${index}`);
  // The client throws on every errored entry, so an entry it handed over with a code is its anomaly.
  if (own === undefined)
    return new KafkaError("protocol", `The request to the broker failed (error code ${errorCode})`);
  if (own.apiId === "GROUP_ID_NOT_FOUND") {
    return new KafkaError(
      "unknown-object",
      `Consumer group ${JSON.stringify(groupId)} could not be described: the broker holds no consumer-protocol group by that id (GROUP_ID_NOT_FOUND)`,
      { apiId: "GROUP_ID_NOT_FOUND" },
    );
  }
  return translateError(own, bootstrap);
}

function stoppedRead(): KafkaError {
  return new KafkaError("timeout", "The read ran past its time limit and was stopped");
}

/** The fetch's answer, or a timeout the moment the signal stops the read; the fetch itself settles on its own. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stoppedRead());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Node's names for a certificate its TLS layer refused: OpenSSL's X509_V_ERR_ names, and UNSPECIFIED
 * for any other (X509ErrorCode in Node's src/crypto/crypto_common.cc; each name is in the node
 * 24.14.0 binary, and a server certificate for client authentication only reached the client as
 * INVALID_PURPOSE under Node 24.14.0 and Bun 1.4.2, measured on 2026-09-25). A handshake the TLS
 * layer itself broke off carries an ERR_TLS_ or ERR_SSL_ code instead.
 */
const CERTIFICATE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "OUT_OF_MEM",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "UNSPECIFIED",
]);
const isTlsCode = (code: string) =>
  code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || CERTIFICATE_CODES.has(code);
/** A code the runtime gave a failure, as opposed to the client's own PLT_KFK_ codes (dist/errors.js). */
const isNodeCode = (code: unknown): code is string => typeof code === "string" && !code.startsWith("PLT_KFK_");
/** The client's own text for one connection's failure: "Connection to <host>:<port> failed." or "... timed out." (dist/network/connection.js). */
const CONNECTION_TARGET = /^Connection to (.+):(\d+) (failed|timed out)\.$/;
/** A connect that timed out before the connection knew its address (dist/network/connection.js, ready()). */
const READY_TIMED_OUT = /^Connection ready timed out after \d+ms\.$/;
/** A connection the peer closed, or one that closed while the client waited for it (dist/network/connection.js). */
const CONNECTION_LOST = /^Connection closed/;

function* walk(error: unknown): Generator<Record<string, unknown>> {
  if (error === null || typeof error !== "object") return;
  const e = error as Record<string, unknown>;
  yield e;
  for (const child of (e.errors as unknown[] | undefined) ?? []) yield* walk(child);
  if (e.cause !== undefined) yield* walk(e.cause);
}

/** The library's own errors carry a PLT_KFK_ code somewhere in their chain (dist/errors.js). */
function isLibraryFailure(error: unknown): boolean {
  return [...walk(error)].some((e) => typeof e.code === "string" && e.code.startsWith("PLT_KFK_"));
}

/** Library failure to domain failure. Messages are this file's own; no credential can reach them. */
export function translateError(error: unknown, bootstrap: { host: string; port: number }): KafkaError {
  if (error instanceof KafkaError) return error;
  const chain = [...walk(error)];
  const top = chain[0] ?? {};
  const apiIds = chain.map((e) => e.apiId).filter((id): id is string => typeof id === "string");
  const messages = chain.map((e) => String(e.message ?? ""));

  const userMessages = chain.filter((e) => e.code === "PLT_KFK_USER").map((e) => String(e.message));
  if (userMessages.some((m) => /^Unknown topic/.test(m))) {
    return new KafkaError("unknown-topic", "The topic does not exist");
  }
  if (apiIds.includes("OFFSET_OUT_OF_RANGE")) {
    return new KafkaError("offset-out-of-range", "The offset is outside the partition's range", {
      apiId: "OFFSET_OUT_OF_RANGE",
    });
  }
  if (apiIds.length > 0 && apiIds.every((id) => LEADERLESS.has(id))) {
    return new KafkaError(
      "unreadable-topic",
      "A partition of the topic has no leader, and the topic cannot be read until every partition has one",
      {
        apiId: apiIds[0],
      },
    );
  }
  const denied = apiIds.find((id) => id.endsWith("_AUTHORIZATION_FAILED"));
  if (denied !== undefined) {
    const resource = denied.replace(/_AUTHORIZATION_FAILED$/, "").toLowerCase();
    return new KafkaError("authorization", `The broker denied access to this ${resource}`, { apiId: denied, resource });
  }
  if (chain.some((e) => e.code === "PLT_KFK_AUTHENTICATION") || apiIds.includes("SASL_AUTHENTICATION_FAILED")) {
    return new KafkaError("authentication", "SASL authentication failed");
  }
  // Protocol mismatches arrive as nested UserErrors (measured M-J), and must be read
  // before the network rule: the handshake failure also carries an ECONNRESET.
  if (userMessages.some((m) => /requires TLS/.test(m))) {
    return new KafkaError("tls", "The broker requires TLS: turn TLS on for this connection");
  }
  if (userMessages.some((m) => /TLS handshake failed/.test(m))) {
    return new KafkaError("tls", "The TLS handshake failed: this port may not speak TLS", { nodeCode: "ECONNRESET" });
  }
  const tls = chain.find((e) => typeof e.code === "string" && isTlsCode(e.code));
  if (tls !== undefined) {
    return new KafkaError("tls", `The TLS handshake failed (${tls.code})`, { nodeCode: tls.code as string });
  }
  // Transport failures. The client wraps every failure to connect to one address in its own
  // "Connection to <host>:<port> failed." (or "... timed out."), with the socket's error as its
  // cause (dist/network/connection.js), so a connection failure is known by that text, whatever
  // Node code its cause carries (EINVAL, EPERM, EADDRNOTAVAIL, ...), while a Node code anywhere
  // else, such as zlib's for a batch that would not decompress, is no connection failure.
  // The library's TimeoutError carries NetworkError's code (PLT_KFK_NETWORK), never
  // PLT_KFK_TIMEOUT, and no Node code (dist/errors.js), so a connect timeout and a closed
  // connection are read from the client's own fixed text too.
  // The target comes from that text, not from the Node error: Node reports the resolved
  // address, so "localhost" would come back as "127.0.0.1" and look like a different broker
  // (measured M-J).
  const connection = chain.find((e) => CONNECTION_TARGET.test(String(e.message ?? "")));
  const target = CONNECTION_TARGET.exec(String(connection?.message ?? ""));
  const causeCode = [...walk(connection?.cause)].map((e) => e.code).find(isNodeCode);
  const connectTimedOut = target?.[3] === "timed out" || messages.some((m) => READY_TIMED_OUT.test(m));
  if (causeCode !== undefined || connectTimedOut || messages.some((m) => CONNECTION_LOST.test(m))) {
    const host = target?.[1] ?? bootstrap.host;
    const port = target ? Number(target[2]) : bootstrap.port;
    const nodeCode = causeCode ?? (connectTimedOut ? "connect-timeout" : "connection-lost");
    if (host !== bootstrap.host || port !== bootstrap.port) {
      return new KafkaError(
        "advertised-unreachable",
        `The broker advertised ${host}:${port}, which this server cannot reach; the cluster's advertised listeners must be reachable from where Studio runs`,
        { host, port, nodeCode },
      );
    }
    return new KafkaError("network", `The broker could not be reached (${nodeCode})`, { nodeCode });
  }
  // The broker accepted the connection and did not answer, or answered that it timed out.
  if (messages.includes("Request timed out") || apiIds.includes("REQUEST_TIMED_OUT")) {
    return new KafkaError("timeout", "The broker did not answer in time");
  }
  if (apiIds.includes("NOT_LEADER_OR_FOLLOWER")) {
    return new KafkaError("protocol", "The partition's leadership moved during the read; run it again", {
      apiId: "NOT_LEADER_OR_FOLLOWER",
    });
  }
  // Named by the protocol error or the library's code, never by the library's message,
  // which can carry a host and a port (spec 3.6 K1).
  const reason = apiIds[0] ?? (typeof top.code === "string" ? top.code : "unknown error");
  return new KafkaError(
    "protocol",
    `The request to the broker failed (${reason})`,
    apiIds[0] ? { apiId: apiIds[0] } : {},
  );
}
