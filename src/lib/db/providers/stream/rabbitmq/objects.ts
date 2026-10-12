/**
 * The RabbitMQ object surface: three static kinds under one container level, the virtual host.
 *
 * A stream is a relation whose columns are the fixed shape of a read result; a queue and an exchange are
 * configuration, shown as labelled JSON parts and never read. Every kind's count comes from its own listing page,
 * so a kind whose count is unavailable has no listing either (`countIsListing`).
 */
import type { ObjectKindSpec } from "@/lib/db/types";

export type RabbitMQKind = "stream" | "queue" | "exchange";

/** The three kinds, each id a `RabbitMQKind`, in the tree's folder order. */
export const RABBITMQ_OBJECT_KINDS: readonly (ObjectKindSpec & { readonly id: RabbitMQKind })[] = Object.freeze([
  {
    id: "stream",
    role: "relation",
    label: "Stream",
    labelPlural: "Streams",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "queue",
    role: "config",
    label: "Queue",
    labelPlural: "Queues",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "exchange",
    role: "config",
    label: "Exchange",
    labelPlural: "Exchanges",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
] as const);
