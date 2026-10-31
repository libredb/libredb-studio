/**
 * The shape of a statement language's pack (#1821). Types only: nothing here is evaluated, so every tier may read it.
 */
import type { ClusterUsageInput } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import type {
  AGENT_STATEMENT_LANGUAGE,
  AgentLanguageCopy,
  AgentStatementLanguageId,
  AgentWorkflowVariant,
} from "../agent-manifest";
import type { AgentCatalogCapture } from "../catalog-rows";
import type { AgentCatalogRead, AgentPlanEstimate } from "../composed-sql-primitives";
import type { AgentGoalShortfall, VerifiableAgentRun } from "../goal-verifier";
import type { AgentInventoryNoun } from "../inventory-noun";
import type { PlanStatementIdentifiers } from "../plan-statement";
import type { AgentPosture } from "../posture";
import type { AgentStatisticsReading } from "../schema-stats";
import type { AgentProfileComposition, AgentProfileDepth } from "../table-profile";
import type { z } from "zod";
import type {
  AgentOperationId,
  AgentRecommendationOutcome,
  AgentTableProfileOutcome,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolName,
  AgentToolOutcome,
} from "../tools";
import type {
  AgentArtifactReference,
  AgentContextSnapshot,
  AgentEvidenceReference,
  AgentInventory,
  AgentRunEvent,
  AgentRunRecord,
  AgentRunWorkflowType,
  AgentToolRefusal,
} from "../types";
import type {
  KubectlEvidenceEvent,
  KubectlEvidenceToolName,
  KubectlReadingDenyCode,
  KubectlShortfall,
  KubectlVariantRequirement,
} from "./kubectl/client";
import type { ENGINE_OVERRIDABLE_SERVER_MEMBERS } from "./overlay";

/** SQL's operations. `sql.explain.analyze` is a member for the reason `AgentOperationId` in `tools.ts` gives. */
type SqlOperationId =
  | "sql.query.read"
  | "sql.explain.estimate"
  | "sql.explain.analyze"
  /** Bounded per-table profiling; #330 T3 reopened the three-descriptor decision. */
  | "sql.table.profile";

/** kubectl's operations: its reads and its two curated cluster readings. */
type KubectlOperationId =
  /** One kubectl read the model wrote, on a `kubernetes` connection; see `kubectlQueryReadDescriptor` for its id. */
  | "kubectl.query.read"
  /** Container usage in one namespace, a curated cluster reading; see `clusterUsageReadDescriptor` for its id. */
  | "cluster.usage.read"
  /** One namespace's workload profile, a curated cluster reading; see `clusterWorkloadsReadDescriptor` for its id. */
  | "cluster.workloads.read";

/** MongoDB's operations. */
type MongoOperationId =
  /** One MongoDB command the model wrote, on a `mongodb` connection; see `mongoQueryReadDescriptor` for its id. */
  | "mongo.query.read"
  /** A scoped MongoDB catalog read from the provider's own inventory; see `mongoSchemaReadDescriptor` for its id. */
  | "mongo.schema.read"
  /** The estimating plan of one MongoDB command; see `mongoPlanEstimateDescriptor` for its id. */
  | "mongo.plan.estimate"
  /** A MongoDB collection profile composed as an aggregation; see `mongoTableProfileDescriptor` for its id. */
  | "mongo.table.profile";

/** The LibreDB command language's operation: its one read. */
type LibredbkvOperationId =
  /** One LibreDB read command the model wrote, on a `libredb` connection; see `libredbkvQueryReadDescriptor`. */
  "libredbkv.query.read";

/** The InfluxQL language's operation: its one read. */
type InfluxqlOperationId =
  /** One InfluxQL read statement the model wrote, on an `influxdb` connection; see `influxqlQueryReadDescriptor`. */
  "influxql.query.read";

/** The Weaviate request language's operation: its one read. */
type WeaviateapiOperationId =
  /** One Weaviate metadata read the model wrote, on a `weaviate` connection; see `weaviateapiQueryReadDescriptor`. */
  "weaviateapi.query.read";

/** The Qdrant request language's operation: its one read. */
type QdrantapiOperationId =
  /** One Qdrant metadata read the model wrote, on a `qdrant` connection; see `qdrantapiQueryReadDescriptor`. */
  "qdrantapi.query.read";

/** The Cypher language's operation: its one read. */
type CypherOperationId =
  /** One Cypher read statement the model wrote, on a `neo4j` connection; see `cypherQueryReadDescriptor`. */
  "cypher.query.read";

/** The Milvus request language's operation: its one read. */
type MilvusrpcOperationId =
  /** One Milvus metadata read the model wrote, on a `milvus` connection; see `milvusrpcQueryReadDescriptor`. */
  "milvusrpc.query.read";

/** The Redis command language's operation: its one read. */
type RediscliOperationId =
  /** One Redis metadata read the model wrote, on a `redis` connection; see `rediscliQueryReadDescriptor`. */
  "rediscli.query.read";

/** The etcdctl command language's operation: its one read. */
type EtcdctlOperationId =
  /** One etcd metadata read the model wrote, on an `etcd` connection; see `etcdctlQueryReadDescriptor`. */
  "etcdctl.query.read";

/** The oxiacli command language's operation: its one read. */
type OxiacliOperationId =
  /** One Oxia metadata read the model wrote, on an `oxia` connection; see `oxiacliQueryReadDescriptor`. */
  "oxiacli.query.read";

/** The rabbitread request language's operation: its one read. */
type RabbitreadOperationId =
  /** One RabbitMQ stream read the model wrote, on a `rabbitmq` connection; see `rabbitreadQueryReadDescriptor`. */
  "rabbitread.query.read";

/** The kafkaread request language's operation: its one read. */
type KafkareadOperationId =
  /** One Kafka metadata read the model wrote, on a `kafka` connection; see `kafkareadQueryReadDescriptor`. */
  "kafkaread.query.read";

/** The fsquery statement language's operation: its one read. */
type FsqueryOperation =
  /** One Firestore metadata read the model wrote, on a `firestore` connection; see `fsqueryQueryReadDescriptor`. */
  "fsquery.query.read";

/** The snmpget command language's operation: its one read. */
type SnmpgetOperation =
  /** One SNMP read the model wrote, on an `snmp` connection; see `snmpgetQueryReadDescriptor`. */
  "snmpget.query.read";

/** The netconfrpc request language's operation: its one read. */
type NetconfrpcOperation =
  /** One NETCONF read the model wrote, on a `netconf` connection; see `netconfrpcQueryReadDescriptor`. */
  "netconfrpc.query.read";

/** The modbusread request language's operation: its one read. */
type ModbusreadOperation =
  /** One Modbus read the model wrote, on a `modbus` connection; see `modbusreadQueryReadDescriptor`. */
  "modbusread.query.read";

/** The PromQL language's operation: its one read. */
type PromqlOperation =
  /** One PromQL read the model wrote, on a `prometheus` connection; see `promqlQueryReadDescriptor`. */
  "promql.query.read";

/** The opcuaread request language's operation: its one read. */
type OpcuareadOperation =
  /** One OPC UA read the model wrote, on an `opcua` connection; see `opcuareadQueryReadDescriptor`. */
  "opcuaread.query.read";

/** The s3api command language's operation: its one read. */
type S3apiOperation =
  /** One S3 metadata read the model wrote, on an `s3` connection; see `s3apiQueryReadDescriptor`. */
  "s3api.query.read";

/**
 * The canonical operations each family's tools drive, by family. `AgentOperationId` in `tools.ts` is the core's two
 * curated ids and every row here, so a family's ids are written once, beside the family's other types.
 */
export interface AgentFamilyOperationIds {
  readonly sql: SqlOperationId;
  readonly kubectl: KubectlOperationId;
  readonly mongo: MongoOperationId;
  readonly libredbkv: LibredbkvOperationId;
  readonly influxql: InfluxqlOperationId;
  readonly weaviateapi: WeaviateapiOperationId;
  readonly qdrantapi: QdrantapiOperationId;
  readonly cypher: CypherOperationId;
  readonly milvusrpc: MilvusrpcOperationId;
  readonly rediscli: RediscliOperationId;
  readonly etcdctl: EtcdctlOperationId;
  readonly oxiacli: OxiacliOperationId;
  readonly rabbitread: RabbitreadOperationId;
  readonly kafkaread: KafkareadOperationId;
  readonly s3api: S3apiOperation;
  readonly fsquery: FsqueryOperation;
  readonly snmpget: SnmpgetOperation;
  readonly netconfrpc: NetconfrpcOperation;
  readonly modbusread: ModbusreadOperation;
  readonly promql: PromqlOperation;
  readonly opcuaread: OpcuareadOperation;
}

/** kubectl's goal verifiers. */
type KubectlVerifierId =
  /**
   * Resource efficiency on a cluster, the kubectl query optimization: a usage reading of this run, cited by a
   * resources recommendation or by a report that recommends nothing.
   *
   * Its own id rather than a new version of the SQL one, because it is a different bar and not a revision of it:
   * a statement and a container are different subjects, and both rules stay live side by side.
   */
  | "agent-query-optimization-kubectl.1"
  /**
   * Cluster health, the kubectl database assessment: the investigation baseline, with a workload profile counted as
   * meaningful even when it holds no row, then at least one workload profile of this run. The report need not cite it.
   *
   * Its own id for the reason the kubectl optimization has one: a workload is not a table, and both rules stay live.
   */
  | "agent-database-assessment-kubectl.1";

/**
 * The goal verifiers each family's rules judge under, by family. `AgentGoalVerifierId` in `goal-verifier.ts` is the
 * core's ids and every row here. SQL has none of its own: its runs are judged by the core's rules.
 */
export interface AgentFamilyVerifierIds {
  readonly sql: never;
  readonly kubectl: KubectlVerifierId;
  /**
   * The MongoDB query optimization, which has no `compare_plans`: an index recommendation citing a plan of this run,
   * as `.3`'s index arm, or a report citing a plan of this run and recommending nothing, because a command whose plan
   * already reaches its documents through an index needs no change. Under `.3` such a run was held until it
   * recommended something, and a live run on 2026-10-17 recommended the index its plan was already using.
   *
   * Its own id, as the kubectl rule has one: `.3` judged MongoDB runs before this existed, and a ledger opened under
   * it keeps that rule, while this one judges the runs opened since.
   */
  readonly mongo: "agent-query-optimization-mongo.1";
  /** None: its workflows are judged by the core's own rules. */
  readonly libredbkv: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly influxql: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly weaviateapi: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly qdrantapi: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly cypher: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly milvusrpc: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly rediscli: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly etcdctl: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly oxiacli: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly rabbitread: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly kafkaread: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly s3api: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly fsquery: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly snmpget: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly netconfrpc: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly modbusread: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly promql: never;
  /** None: its workflows are judged by the core's own rules. */
  readonly opcuaread: never;
}

/** The operation a family's model-written reads are evaluated under: its row's `<family>.query.read`. */
type AgentFamilyReadOperation = {
  [F in keyof AgentFamilyOperationIds]: Extract<AgentFamilyOperationIds[F], `${F}.query.read`>;
}[keyof AgentFamilyOperationIds];

export interface AgentLanguageServerAdapter {
  /** The descriptor this language's model-written reads are evaluated under. */
  readonly readOperation: AgentFamilyReadOperation;
  /**
   * The model's argument as the one statement text every server layer reads: the fence, the provider, the ledger
   * and the repair identity. Null for any value that carries no statement, which the caller refuses rather than
   * sending.
   */
  readonly canonicalize: (raw: unknown) => string | null;
  /** Total over any text: the repair ledger's identity of one call. */
  readonly fingerprint: (text: string) => string;
  /** The sentence for a read refused past the row budget. */
  readonly rowCapAdvice: (statement: string, allowed: string) => string;
  /** The admission pre-check: the reader's own refusal, or null when admitted. Null for SQL, whose shape advice stays (D6). */
  readonly admit: ((text: string) => { readonly code: string; readonly message: string } | null) | null;
  /** The sentence a shape denial carries, in this language's words. Absent for SQL, whose sentence stays (D6). */
  readonly shapeAdvice?: string;
  /**
   * The check of an admitted statement against the run's captured inventory, for a language whose engine answers a
   * mistake the inventory already shows with an empty result instead of an error: the model's sentence, or null when
   * the inventory sees nothing wrong or cannot tell. Absent for SQL and kubectl, whose engines refuse such a statement
   * themselves. See `mongo/inventory-check.ts`.
   */
  readonly inventoryProblem?: (text: string, inventory: AgentInventory | null) => string | null;
  /**
   * The names a plan-mode draft in this language uses, read against the inventory, for a language whose drafts this
   * server can read for names although the SQL guard cannot read them. Absent for SQL, whose drafts the SQL reader in
   * `plan-statement.ts` checks, and for kubectl.
   */
  readonly planDraftIdentifiers?: (text: string, inventory: AgentInventory | null) => PlanStatementIdentifiers;
}

/**
 * A `recommend_change` card: the schema a call is parsed with, and how a parsed call is recorded. SQL's statement card
 * (`sql/recommendation.ts`) is the reference one, a change stated as a statement an editor runs; a language whose change
 * is no such statement offers its own card, a change stated as data. `recommendChangeTool` in `tools.ts` reads a call
 * with the card that owns the offered definition's schema, and checks every evidence reference against the run's
 * ledger and refuses an unverifiable one before `record` is called, so `record` only ever sees verified evidence.
 */
export interface AgentRecommendationCard<
  Card extends { readonly evidence: readonly AgentEvidenceReference[] } = {
    readonly evidence: readonly AgentEvidenceReference[];
  },
> {
  readonly inputSchema: z.ZodType<Card>;
  /** The call as models send it, read back into the call the schema accepts before it is parsed. Absent: as sent. */
  readonly prepare?: (input: unknown) => unknown;
  /**
   * What a call that did not parse is told on top of the failing paths: a worked call and the card's own shape
   * sentence, each where the card has one. `input` is the call as sent, before `prepare`. Absent: the paths alone.
   */
  refuseParse?(
    input: unknown,
    problems: string,
    events: readonly AgentRunEvent[],
    modelId: string,
  ): { readonly example: string | undefined; readonly shape: string | undefined };
  /** A refusal of a parsed card, made before the core checks its evidence, or undefined when there is none. */
  refuseBeforeEvidence?(
    card: Card,
    events: readonly AgentRunEvent[],
    modelId: string,
  ): AgentRecommendationOutcome | undefined;
  /** Called after the core verified the card's evidence; returns the outcome verbatim. */
  record(events: readonly AgentRunEvent[], card: Card): AgentRecommendationOutcome;
}

/**
 * How an agent-mode run of a language is grounded in words its own tools can act on.
 *
 * `omissionAdvice` names the tool that reads what the packing left out: `inspect_schema` on SQL, and on kubectl,
 * which holds no `inspect_schema`, a `run_read_query` get. `relations` says whether the relations block is shown at
 * all: a cluster declares no foreign keys, and the block's own omission advice names `inspect_schema` again.
 * `ungrounded` replaces the capture's own advice where the run cannot be ungrounded in the capture's words, which
 * send a model to `inspect_schema`; absent, the capture's text is forwarded as it always was. The diagnosis is
 * passed through as-is, joined with a newline, for the reasons `operationsUngroundedNote` records.
 */
export interface AgentLanguageGrounding {
  readonly omissionAdvice: string;
  readonly relations: boolean;
  readonly ungrounded?: (detail: string, noun: AgentInventoryNoun) => string;
  /**
   * The language's engine declares no fields, so its inventory's are inferred from sampled documents and a field
   * every sample held is no constraint: the packing then states no NOT NULL (`packContextForTask`).
   */
  readonly sampledFields?: boolean;
  /** What a plan-mode draft in this language is told on top of the shared contract (`planningStatementContract`). */
  readonly planningRules?: readonly string[];
  /**
   * Where the language's engine is never listed, so no inventory ever grounds a plan, what an ungrounded plan-mode draft
   * is told in place of the no-inventory refusal: it is given the statement contract without its inventory sentences,
   * and these rules say where its names come from instead. Absent, an ungrounded plan refuses as it always has.
   */
  readonly ungroundedPlanning?: readonly string[];
}

/** What a run is told about a shortfall, and whether it is narrowed to its verdict's tools while it acts on it. */
export interface ShortfallAdvice {
  readonly said: string;
  /**
   * Whether narrowing the run to its verdict's tools would HELP this shortfall.
   *
   * False wherever the fix lies outside that set, and an eval caught the case immediately:
   * the answer to `no-plan-evidence` is to call `inspect_plan`, which is a READING tool and
   * so not among the tools the optimization verdict accepts. Narrowing there would have
   * removed the very tool this notice asks for — telling a run to do something and taking
   * away its means of doing it, which is the shape of mistake this file has already paid
   * for twice.
   */
  readonly narrow: boolean;
}

/**
 * What the run holds and calls things, as a shortfall notice needs it: the plans it inspected, oldest first, whether it
 * is offered `compare_plans` at all, and what its language calls one unit it sends.
 */
export interface ShortfallContext {
  readonly plans: readonly string[];
  readonly readingsHeld: number;
  readonly holdsPresentable: boolean;
  readonly holdsCompare: boolean;
  readonly noun: string;
}

/**
 * One shortfall's notice: the advice for a report about to be refused, from the table it spoke of and what the run
 * holds, or null where this shortfall cannot honestly be asked about on this run.
 */
export type ShortfallNotice = (table: string | undefined, context: ShortfallContext) => ShortfallAdvice | null;

/** What a language does on the server, below `tools.ts`. Reached through `languageServerPack` in `server.ts`. */
export interface AgentLanguageServerPack {
  readonly adapter: AgentLanguageServerAdapter;
  /**
   * The tool definitions a workflow on this language replaces, keyed by workflow, because a language's tools are not
   * uniform across its workflows: one kubectl workflow may be offered a schema another is not. Keyed rather than
   * compared, so a later language or workflow registers its own row and no call site changes. Read by
   * `agentToolDefinition` in `tools.ts`; a tool no row names is the core's own definition.
   */
  readonly toolOverrides: Readonly<
    Partial<Record<AgentRunWorkflowType, Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>>>>
  >;
  /**
   * Tools only this language's workflows offer, which have no core definition to override. Merged into
   * `AGENT_TOOL_DEFINITIONS` through `LANGUAGE_BASE_DEFINITIONS` in `server.ts`, so a tool name is still defined once.
   */
  readonly baseDefinitions: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>>;
  /**
   * `ANSWER_NOT_A_DATA_READ` in the words of this language, the refusal a run meets when it presents a plan or a
   * profile.
   */
  readonly answerNotADataRead: string;
  /**
   * The advice for a statement that read another engine's catalog, from the engine's message and the engine this
   * connection is, or undefined when the message names no foreign catalog. Absent for a language with no such mistake.
   */
  readonly catalogAdvice?: (message: string, engine: string) => string | undefined;
  /** The card this language's `recommend_change` offers. Absent for a language that offers only the reference card. */
  readonly recommendationCard?: AgentRecommendationCard;
  /** How an agent-mode run of this language is grounded in words its own tools can act on. */
  readonly grounding: AgentLanguageGrounding;
  /**
   * The tool rules by workflow, for the workflows this language has a variant of and no more. Read through
   * `workflowToolRules` in `investigation.ts`, which throws for a workflow the record does not hold.
   */
  readonly workflowToolRules: Readonly<Partial<Record<AgentRunWorkflowType, string>>>;
  /**
   * The shortfall notices only this language's verdicts call for. Global by shortfall: merged into
   * `LANGUAGE_SHORTFALL_NOTICES` in `server.ts`, and with the core's in `investigation.ts`, where a shortfall two
   * owners both speak for fails at load.
   */
  readonly shortfallNotices: Readonly<Partial<Record<AgentGoalShortfall, ShortfallNotice>>>;
  /**
   * What a run is told the moment it holds a usage reading, for the one language whose workflow is judged on one.
   * Read through `LANGUAGE_USAGE_BAR_NOTICE` in `server.ts`, which exactly one pack supplies.
   */
  readonly usageBarNotice?: string;
  /**
   * The evidence tool whose reading makes the usage bar due, supplied with `usageBarNotice`. Read through
   * `LANGUAGE_USAGE_BAR_TOOL` in `server.ts`.
   */
  readonly usageBarTool?: EvidenceToolName;
}

/** A catalog arm: the selector it parses, and the read. `snapshot` is the inventory this run captured, or null. */
export interface InspectSchemaArm {
  readonly inputSchema: z.ZodType<unknown>;
  run(context: AgentToolContext, input: unknown, snapshot: AgentContextSnapshot | null): Promise<AgentToolOutcome>;
}

/** A plan arm: the statement it parses, and the estimating plan of it. */
export interface InspectPlanArm {
  readonly inputSchema: z.ZodType<unknown>;
  run(context: AgentToolContext, input: unknown, snapshot?: AgentContextSnapshot | null): Promise<AgentToolOutcome>;
}

/**
 * What every language's planned profile carries for the step it settles as: the target the spelling RESOLVED to, the
 * depth, and where in the object's columns the batch starts. Two requests naming one object at one depth and one
 * batch are one step, whatever spelling reached it.
 */
export interface ProfileArmPlan {
  readonly target: { readonly schema?: string; readonly table: string };
  readonly depth: AgentProfileDepth;
  readonly from: number;
}

/**
 * A profile arm: the selector its planning step parses, the planning step that resolves and composes and reaches
 * nothing, and the read of what it planned. `run` is only ever handed the plan its own `plan` produced, which is what
 * lets each language's plan carry what that language's read needs.
 */
export interface ProfileArm<Plan extends ProfileArmPlan = ProfileArmPlan> {
  readonly inputSchema: z.ZodType<unknown>;
  plan(
    context: AgentToolContext,
    run: Pick<AgentRunRecord, "runId" | "events">,
    input: unknown,
  ): { readonly kind: "planned"; readonly plan: Plan } | (AgentToolOutcome & { readonly kind: "unavailable" });
  run(context: AgentToolContext, plan: Plan): Promise<AgentTableProfileOutcome>;
}

/**
 * What a statement language does when a run calls one of the tools whose execution differs by language:
 * `inspect_schema`, `inspect_plan` and `profile_table`.
 *
 * The execution half of what a pack's `toolOverrides` is for the offer, keyed the same way, by language: a run is
 * offered a language's definition of a tool and executed by that language's arm of it, so the two cannot come to
 * disagree, and nothing anywhere tests a language id to choose between them. Each arm declares as its input the
 * exported schema its tool parses with, and `tests/unit/lib/agent/tool-offer-census.test.ts` holds that declaration
 * equal to the schema the definition offers, so what a run is offered is what it is held to. The operation a step is
 * recorded under is the definition's own (`agentToolDefinition`), as it is for every database tool, so an arm does not
 * declare a second one.
 *
 * A language that offers none of these tools has none (kubectl, whose variants offer reads and curated readings only);
 * the run loop treats a tool it is asked to execute with no arm as its own fault, never as a reason to fall back to
 * SQL's.
 */
export interface LanguageToolArms {
  readonly inspect_schema?: InspectSchemaArm;
  readonly inspect_plan?: InspectPlanArm;
  readonly profile_table?: ProfileArm;
}

/**
 * The readings each family offers whose result is EVIDENCE of a kind a verdict asks for, so the drive writes an event of
 * that kind beside the settled step. They reach the engine through `service.runStep` like any database tool and are
 * handled apart only because of that event; see `readEvidence` in `investigation.ts`.
 */
export interface AgentFamilyEvidenceTools {
  readonly sql: never;
  readonly kubectl: KubectlEvidenceToolName;
  readonly mongo: never;
  readonly libredbkv: never;
  readonly influxql: never;
  readonly weaviateapi: never;
  readonly qdrantapi: never;
  readonly cypher: never;
  readonly milvusrpc: never;
  readonly rediscli: never;
  readonly etcdctl: never;
  readonly oxiacli: never;
  readonly rabbitread: never;
  readonly kafkaread: never;
  readonly s3api: never;
  readonly fsquery: never;
  readonly snmpget: never;
  readonly netconfrpc: never;
  readonly modbusread: never;
  readonly promql: never;
  readonly opcuaread: never;
}

/** Every pack's evidence tool: a member of the core's `AgentToolName`, declared by the pack that offers it. */
export type EvidenceToolName = AgentFamilyEvidenceTools[keyof AgentFamilyEvidenceTools];

/** The reading refusal codes only one family's readings raise, by family; the core's own are in `types.ts`. */
export interface AgentFamilyReadingDenyCodes {
  readonly sql: never;
  readonly kubectl: KubectlReadingDenyCode;
  readonly mongo: never;
  readonly libredbkv: never;
  readonly influxql: never;
  readonly weaviateapi: never;
  readonly qdrantapi: never;
  readonly cypher: never;
  readonly milvusrpc: never;
  readonly rediscli: never;
  readonly etcdctl: never;
  readonly oxiacli: never;
  readonly rabbitread: never;
  readonly kafkaread: never;
  readonly s3api: never;
  readonly fsquery: never;
  readonly snmpget: never;
  readonly netconfrpc: never;
  readonly modbusread: never;
  readonly promql: never;
  readonly opcuaread: never;
}

/** Every pack's reading refusal code: a member of the core's `AgentReadingDenyCode`, declared by its pack. */
export type AgentPackReadingDenyCode = AgentFamilyReadingDenyCodes[keyof AgentFamilyReadingDenyCodes];

/** The verdict shortfalls only one family's verifiers report, by family; the core's own are in `goal-verifier.ts`. */
export interface AgentFamilyShortfalls {
  readonly sql: never;
  readonly kubectl: KubectlShortfall;
  readonly mongo: never;
  readonly libredbkv: never;
  readonly influxql: never;
  readonly weaviateapi: never;
  readonly qdrantapi: never;
  readonly cypher: never;
  readonly milvusrpc: never;
  readonly rediscli: never;
  readonly etcdctl: never;
  readonly oxiacli: never;
  readonly rabbitread: never;
  readonly kafkaread: never;
  readonly s3api: never;
  readonly fsquery: never;
  readonly snmpget: never;
  readonly netconfrpc: never;
  readonly modbusread: never;
  readonly promql: never;
  readonly opcuaread: never;
}

/** Every pack's verdict shortfall: a member of the core's `AgentGoalShortfall`, declared by its pack. */
export type AgentPackShortfall = AgentFamilyShortfalls[keyof AgentFamilyShortfalls];

/** What one family's workflow variants need of an engine beyond its language, by family. */
export interface AgentFamilyVariantRequirements {
  readonly sql: never;
  readonly kubectl: KubectlVariantRequirement;
  readonly mongo: never;
  readonly libredbkv: never;
  readonly influxql: never;
  readonly weaviateapi: never;
  readonly qdrantapi: never;
  readonly cypher: never;
  readonly milvusrpc: never;
  readonly rediscli: never;
  readonly etcdctl: never;
  readonly oxiacli: never;
  readonly rabbitread: never;
  readonly kafkaread: never;
  readonly s3api: never;
  readonly fsquery: never;
  readonly snmpget: never;
  readonly netconfrpc: never;
  readonly modbusread: never;
  readonly promql: never;
  readonly opcuaread: never;
}

/** Every pack's variant requirement: a member of the core's `AgentVariantRequirement`, declared by its pack. */
export type AgentPackVariantRequirement = AgentFamilyVariantRequirements[keyof AgentFamilyVariantRequirements];

/** What a pack states of one of its variant requirements: the engines it holds on, and the refusal where it does not. */
export interface AgentVariantRequirementSpec {
  readonly engines: readonly DatabaseType[];
  /** The refusal, naming what the engine lacks and both ways forward that remain. */
  readonly sentence: string;
}

/** One evidence tool, as the run loop executes it. */
export interface AgentEvidenceTool {
  /**
   * The argument schema, which names the namespace the event records. Typed as the usage reading's input because it is
   * the wider of the two: a profile's namespace alone is one with no selector.
   */
  readonly input: z.ZodType<ClusterUsageInput>;
  readonly run: (context: AgentToolContext, input: unknown) => Promise<AgentToolOutcome>;
  /**
   * The kind of the event the tool writes when it completes. Typed through the packs' evidence events, so a kind the
   * ledger does not admit cannot be named here.
   */
  readonly event: Extract<AgentPackEvidenceEvent, { readonly artifact: AgentArtifactReference }>["kind"];
  /** The event a completed reading writes: its artifact and what the parsed `input` covered. Of the kind `event`. */
  readonly completed: (artifact: AgentArtifactReference, input: ClusterUsageInput) => AgentPackEvidenceEvent;
  /**
   * The event a refused reading writes, or null for none: a refusal that is a fact about the engine rather than about
   * the call, which a verdict reads to tell the engine apart from the run.
   */
  readonly refused: (refusal: AgentToolRefusal, input: ClusterUsageInput) => AgentPackEvidenceEvent | null;
}

/**
 * The evidence events each family writes on the ledger, by family, each without its timestamp. `AgentRunEvent` in
 * `types.ts` holds every row here beside the core's own kinds, so a family's events are written once, in its pack, and
 * the core names none of them. Every one is narrative: it is written beside a step that settles on its own, so none
 * settles one.
 */
export interface AgentFamilyEvidenceEvents {
  readonly sql: never;
  readonly kubectl: KubectlEvidenceEvent;
  readonly mongo: never;
  readonly libredbkv: never;
  readonly influxql: never;
  readonly weaviateapi: never;
  readonly qdrantapi: never;
  readonly cypher: never;
  readonly milvusrpc: never;
  readonly rediscli: never;
  readonly etcdctl: never;
  readonly oxiacli: never;
  readonly rabbitread: never;
  readonly kafkaread: never;
  readonly s3api: never;
  readonly fsquery: never;
  readonly snmpget: never;
  readonly netconfrpc: never;
  readonly modbusread: never;
  readonly promql: never;
  readonly opcuaread: never;
}

/** Every pack's evidence event, as the ledger stores it less its timestamp. */
export type AgentPackEvidenceEvent = AgentFamilyEvidenceEvents[keyof AgentFamilyEvidenceEvents];

/** What the timeline shows of one pack evidence event, all of it the app's own words. */
export interface AgentEvidenceTimelineEntry {
  readonly tone: "neutral" | "progress";
  readonly headline: string;
  readonly detail: string;
  /** The artifact the event carries, so the rail can resolve a citation of it. */
  readonly artifactId?: string;
}

/** What a pack declares of one of its evidence events, for the core readers that dispatch on its kind. */
export interface AgentEvidenceEventSpec<Event> {
  /** Whether the event carries an artifact this run produced, so a claim may cite it. */
  readonly citable: boolean;
  /** What the timeline shows for it. */
  readonly timeline: (event: Event) => AgentEvidenceTimelineEntry;
  /** The sentence a resumed run is told of it, so it does not read again what it already holds. */
  readonly priorProgress: (event: Event) => string;
}

/** One declaration per kind of `Event`, total, so a kind a family adds does not compile until it is declared. */
export type AgentEvidenceEventSpecs<Event extends { readonly kind: string }> = {
  readonly [Kind in Event["kind"]]: AgentEvidenceEventSpec<Extract<Event, { readonly kind: Kind }>>;
};

/**
 * One verifier id's rule. A language's rules live in `<id>/verifiers.ts` and reach `goal-verifier.ts` only through
 * `LANGUAGE_GOAL_RULES` in `verifiers.ts`, keyed by the persisted id, so a resumed run is judged by its own id whatever
 * its language.
 */
export type AgentGoalRule = (run: VerifiableAgentRun) => readonly AgentGoalShortfall[];

/** What a language executes, above `tools.ts`. Reached through `agentLanguagePack` in `index.ts`. */
export interface AgentLanguageExecutionPack {
  readonly arms: LanguageToolArms;
  /** Global by tool name: merged into `AGENT_EVIDENCE_TOOLS` in `index.ts`, where a name two packs hold fails. */
  readonly evidenceTools: Readonly<Partial<Record<EvidenceToolName, AgentEvidenceTool>>>;
}

/** The per-statement bounds a posture or a consent sentence names: rows and seconds, from one policy row. */
export type StatementBudgets = { readonly maxResultRows: number; readonly statementTimeoutMs: number };

/**
 * What a language contributes to the browser: data a client bundle may hold, with no server code behind it. Reached
 * through `languageClientPack` in `client.ts`, and read whole by `agent-manifest.ts` through its projections.
 */
export interface AgentLanguageClientPack {
  /** The words the run's sentences use: `AGENT_LANGUAGE_COPY` in `agent-manifest.ts` projects it. */
  readonly copy: AgentLanguageCopy;
  /** The language's workflow variants: `AGENT_WORKFLOW_VARIANTS` in `agent-manifest.ts` projects it. */
  readonly variants: Readonly<Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>;
  /** The operation the language's `inspect_plan` drives, or null with no plan to read: `AGENT_PLAN_ESTIMATE_OPERATION`. */
  readonly planEstimateOperation: AgentOperationId | null;
  /**
   * The evidence events the language writes, keyed by kind: `AGENT_EVIDENCE_EVENTS` in `client.ts` merges every
   * language's, and holds the merge total over `AgentPackEvidenceEvent`.
   */
  readonly evidenceEvents: Readonly<Record<string, AgentEvidenceEventSpec<never>>>;
  /**
   * What the timeline says of each shortfall only this language's verifiers report: `AGENT_PACK_SHORTFALL_SENTENCES` in
   * `client.ts` merges every language's, total over `AgentPackShortfall`.
   */
  readonly shortfallSentences: Readonly<Record<string, string>>;
  /**
   * What the timeline calls each reading refusal only this language raises: `AGENT_PACK_READING_REFUSAL_HEADLINES` in
   * `client.ts` merges every language's, total over `AgentPackReadingDenyCode`.
   */
  readonly readingRefusalHeadlines: Readonly<Record<string, string>>;
  /**
   * The requirements only this language's workflow variants name: `AGENT_PACK_REQUIREMENTS` in `client.ts` merges every
   * language's, total over `AgentPackVariantRequirement`, and `agent-manifest.ts` reads the merge.
   */
  readonly requirements: Readonly<Record<string, AgentVariantRequirementSpec>>;
  /** What `posture.ts` says of an agent-mode run in this language. */
  readonly posture: {
    /**
     * Agent mode, executing on its own path and nowhere else, under the boundary its language declares. Keyed by
     * language rather than compared, like the hand-over terms.
     */
    readonly reads: (bounds: StatementBudgets) => AgentPosture;
    /**
     * Agent mode with the editor hand-over consented: still read-only, and one statement wider.
     *
     * Only SQL has a widened reading. On a cluster and on MongoDB no workflow variant offers the
     * hand-over, so a tick there consents to nothing and the posture stays the reads one: a
     * "widened" pill would claim an editor run the engine never performs.
     */
    readonly widened: (bounds: StatementBudgets) => AgentPosture;
    /**
     * One consent sentence per statement language, keyed rather than compared, so a language
     * registered in the manifest does not compile until it says what its hand-over is.
     */
    readonly handoverTerms: (budgets: StatementBudgets) => string;
    /**
     * What plan mode says in this language, where the shared plan posture is not true of it. Absent on every language
     * whose grounding is a schema read of the engine; Modbus's grounding is the register map, which sends the device
     * nothing, while opening the connection dials it, so "nothing else reaches the database" would be false there.
     */
    readonly plan?: () => AgentPosture;
  };
}

/**
 * One statement language, whole. Each facet is reachable alone through its tier's accessor, which returns the very
 * object the pack holds: `languageClientPack` in `client.ts` for the client facet, which the browser modules read,
 * `languageServerPack` in `server.ts` for the server facet, which `tools.ts` reads below the execution tier, and
 * `agentLanguagePack` in `index.ts` for the whole pack, which only the run loop reads.
 */
export interface AgentLanguagePack {
  readonly id: AgentStatementLanguageId;
  readonly client: AgentLanguageClientPack;
  readonly server: AgentLanguageServerPack;
  readonly execution: AgentLanguageExecutionPack;
}

/** What an engine overlay says of a dialect-bound member it has no verified composition for. */
export type Unsupported = "unsupported";

/** What a client overlay says of a server member: present or not, as data a browser may hold. */
export type Supported = "supported" | Unsupported;

/**
 * One member of a facet as an overlay may give it: the value itself, or a derivation from the base value. A function
 * in an overlay is always a derivation, so a member whose value is a function is only ever derived.
 */
export type MemberOverride<V> =
  | ((base: V) => Exclude<V, undefined>)
  | (Exclude<V, undefined> extends (...args: never[]) => unknown ? never : Exclude<V, undefined>);

/** What an overlay may give of a facet: any of its members, each as a `MemberOverride`. Read by `defineOverlay`. */
export type FacetOverrides<Facet> = { readonly [K in keyof Facet]?: MemberOverride<Facet[K]> };

/** The engines that speak a statement language, read from the literal-typed `AGENT_STATEMENT_LANGUAGE`. */
export type AgentEngineType = {
  [T in DatabaseType]: (typeof AGENT_STATEMENT_LANGUAGE)[T] extends null ? never : T;
}[DatabaseType];

/** The statement language an engine speaks, its family. */
export type AgentEngineFamily<T extends AgentEngineType> = NonNullable<(typeof AGENT_STATEMENT_LANGUAGE)[T]>;

/**
 * The members of a SQL engine's server facet that are bound to its dialect: each one a verified composition, or
 * `"unsupported"`, which the core refuses in its own words. Every SQL engine's overlay says one or the other for every
 * member, so an engine that composes nothing has to say so.
 */
export interface SqlServerDialect {
  /** The catalog read (`composeCatalogRead` in `composed-sql.ts`, `readCatalog` in `tools.ts`). */
  readonly catalogRead: AgentCatalogRead | Unsupported;
  /** The estimating plan request (`composeEstimatingExplain` in `composed-sql.ts`). */
  readonly planEstimate: AgentPlanEstimate | Unsupported;
  /** The `profile_table` composition (`composeTableProfile` in `table-profile.ts`). */
  readonly profileComposition: AgentProfileComposition | Unsupported;
  /** The statistics reading (`composeStatisticsAvailabilityProbe` in `composed-sql.ts`, `schema-stats.ts`). */
  readonly statistics: AgentStatisticsReading | Unsupported;
  /** The grounding capture's composed catalog read (`readInventory` in `context-snapshot.ts`). */
  readonly catalogCapture: AgentCatalogCapture | Unsupported;
}

/**
 * The client view of a server dialect: the members a browser asks about, each only as present or not, so a client
 * learns which engines compose a catalog read or capture without loading the composition. Typed from the server
 * overlay itself (`languages/sql/engines/client.ts`), so a client `"unsupported"` beside a supplied member, or a
 * `"supported"` beside an unsupported one, does not compile.
 */
export type ClientDialectOf<D> = {
  readonly [K in keyof D as K extends "catalogRead" | "planEstimate" | "catalogCapture"
    ? K
    : never]: D[K] extends Unsupported ? Unsupported : "supported";
};

/** The client view of a SQL engine's dialect: which of its catalog read, plan estimate and catalog capture it supplies. */
export interface SqlClientDialect {
  readonly catalogRead: Supported;
  readonly planEstimate: Supported;
  readonly catalogCapture: Supported;
}

/** One explicit row per family, no default branch: a fourth `AgentStatementLanguageId` fails to compile until its row exists. */
export interface AgentFamilyDialectRows {
  sql: { client: SqlClientDialect; server: SqlServerDialect };
  mongo: { client: Record<never, never>; server: Record<never, never> };
  kubectl: { client: Record<never, never>; server: Record<never, never> };
  libredbkv: { client: Record<never, never>; server: Record<never, never> };
  influxql: { client: Record<never, never>; server: Record<never, never> };
  weaviateapi: { client: Record<never, never>; server: Record<never, never> };
  qdrantapi: { client: Record<never, never>; server: Record<never, never> };
  cypher: { client: Record<never, never>; server: Record<never, never> };
  milvusrpc: { client: Record<never, never>; server: Record<never, never> };
  rediscli: { client: Record<never, never>; server: Record<never, never> };
  etcdctl: { client: Record<never, never>; server: Record<never, never> };
  oxiacli: { client: Record<never, never>; server: Record<never, never> };
  rabbitread: { client: Record<never, never>; server: Record<never, never> };
  kafkaread: { client: Record<never, never>; server: Record<never, never> };
  s3api: { client: Record<never, never>; server: Record<never, never> };
  fsquery: { client: Record<never, never>; server: Record<never, never> };
  snmpget: { client: Record<never, never>; server: Record<never, never> };
  netconfrpc: { client: Record<never, never>; server: Record<never, never> };
  modbusread: { client: Record<never, never>; server: Record<never, never> };
  promql: { client: Record<never, never>; server: Record<never, never> };
  opcuaread: { client: Record<never, never>; server: Record<never, never> };
}

/** The dialect-bound members of each family, client and server. */
export type AgentFamilyDialect = { readonly [F in AgentStatementLanguageId]: AgentFamilyDialectRows[F] };

/** A family with no dialect-bound member gives its engines no `dialect` at all. */
type DialectSlot<D> = keyof D extends never ? { readonly dialect?: never } : { readonly dialect: D };

/** The server members an engine overlay may override, as `ENGINE_OVERRIDABLE_SERVER_MEMBERS` names them. */
export type AgentEngineOverridableServer = Pick<
  AgentLanguageServerPack,
  (typeof ENGINE_OVERRIDABLE_SERVER_MEMBERS)[number]
>;

/**
 * What an engine's server overlay holds: its family's dialect-bound members, and any of the members
 * `ENGINE_OVERRIDABLE_SERVER_MEMBERS` names, each a value or a derivation from the family's (`MemberOverride`). Only
 * those are overridable, because only those are read through the run resolver everywhere they are read; an override
 * of any other member would compile and reach no reader, so it does not compile.
 */
export type AgentEngineServerOverlay<F extends AgentStatementLanguageId> =
  FacetOverrides<AgentEngineOverridableServer> & DialectSlot<AgentFamilyDialect[F]["server"]>;

/** The client counterpart of `AgentEngineServerOverlay`. */
export type AgentEngineClientOverlay<F extends AgentStatementLanguageId> = DialectSlot<AgentFamilyDialect[F]["client"]>;

/** Every engine's server overlay, total over `AgentEngineType`: the registry in `engines/server.ts`. */
export type AgentEngineServerOverlays = {
  readonly [T in AgentEngineType]: AgentEngineServerOverlay<AgentEngineFamily<T>>;
};

/** Every engine's client overlay, with the family it overlays, total over `AgentEngineType`: the registry in `engines/client.ts`. */
export type AgentEngineClientOverlays = {
  readonly [T in AgentEngineType]: {
    readonly family: AgentEngineFamily<T>;
    readonly overlay: AgentEngineClientOverlay<AgentEngineFamily<T>>;
  };
};

/** The core's merged view of the server dialect: every member of every family; an engine without one answers `"unsupported"`. */
export type AgentEngineServerDialect = AgentFamilyDialectRows["sql"]["server"];

/** The core's merged view of the client dialect. */
export type AgentEngineClientDialect = AgentFamilyDialectRows["sql"]["client"];

/**
 * One engine's pack: its family's pack, with the engine's dialect on the client and server facets. An engine whose
 * overlays are empty is its family's pack itself (`agentEnginePack` in `engines/index.ts`).
 */
export interface AgentEnginePack extends Omit<AgentLanguagePack, "server" | "client"> {
  readonly server: AgentLanguageServerPack & { readonly dialect?: AgentEngineServerDialect };
  readonly client: AgentLanguageClientPack & { readonly dialect?: AgentEngineClientDialect };
}
