/**
 * The cautions only a user's Test Connection asks for, never an error: an active resource alarm, an account with no
 * virtual host, and classic or quorum queues this account could take messages from.
 *
 * The queue check runs only when the broker lists the rabbitmq_stream_management plugin, and is bounded three ways:
 * the Queues page of at most the first 6 virtual hosts, at most 50 tracking GETs, and one check deadline over all of
 * it. Measured on RabbitMQ 4.3.6 with 30,000 queues in one virtual host, one Queues page took up to 0.8 s, so 6 pages
 * take at most about 4.8 s, half the 10 s check deadline; 50 tracking GETs took under 35 ms in all. Whatever a bound
 * or the deadline left unchecked is counted in the caution of a virtual host where a readable queue was found.
 */
import type { QueryWarning } from "@/lib/db/types";
import { TimeoutError } from "@/lib/db/errors";
import {
  ALARM_CAUTION,
  NO_VHOSTS_CAUTION,
  readableQueuesCaution,
  readableQueuesInMoreVhosts,
  VhostAccessError,
} from "./errors";
import {
  type DeadlineSignalFactory,
  RABBITMQ_CAUTION_MAX_VHOSTS,
  RABBITMQ_CAUTION_NAMED_QUEUES,
  RABBITMQ_TEST_CHECK_DEADLINE_MS,
  RABBITMQ_TEST_CHECK_MAX_QUEUES,
  RABBITMQ_TEST_CHECK_MAX_VHOSTS,
} from "./limits";
import type { GetOptions, ManagementClient } from "./management/client";
import type { TrackingProbe } from "./tracking-probe";

const QUEUE_TYPES: ReadonlySet<string> = new Set(["classic", "quorum"]);

/** One virtual host's finding: the readable queues in listing order and how many of its queues went unchecked. */
interface VhostFinding {
  readonly vhost: string;
  readonly readable: readonly string[];
  readonly notChecked: number;
}

/** A GET the check deadline, or its own deadline, stopped: the check ends there and counts what it did not reach. */
const stoppedByDeadline = (error: unknown) => error instanceof TimeoutError;

export async function testConnectionCautions(
  client: ManagementClient,
  tracking: TrackingProbe,
  deadlineSignal: DeadlineSignalFactory,
): Promise<QueryWarning[]> {
  const options: GetOptions = { within: deadlineSignal(RABBITMQ_TEST_CHECK_DEADLINE_MS), site: "test-connection" };
  const cautions: string[] = [];
  if ((await client.get("alarms", {}, options)).active) cautions.push(ALARM_CAUTION);
  const vhosts = await client.get("vhosts", {}, options);
  if (vhosts.length === 0) return [...cautions, NO_VHOSTS_CAUTION].map((message) => ({ message }));
  if (!(await tracking.streamManagementListed(options))) return cautions.map((message) => ({ message }));

  const findings: VhostFinding[] = [];
  let budget = RABBITMQ_TEST_CHECK_MAX_QUEUES;
  let stopped = false;
  for (const { name: vhost } of vhosts.slice(0, RABBITMQ_TEST_CHECK_MAX_VHOSTS)) {
    if (stopped || budget === 0) break;
    let queues: readonly string[];
    try {
      const page = await client.get("queues-page", { vhost }, options);
      queues = page.items.filter((row) => QUEUE_TYPES.has(row.type)).map((row) => row.name);
    } catch (error) {
      // A virtual host this account may not list holds nothing it could take.
      if (error instanceof VhostAccessError) continue;
      if (stoppedByDeadline(error)) break;
      throw error;
    }
    const readable: string[] = [];
    let notChecked = 0;
    for (const queue of queues) {
      if (stopped || budget === 0) {
        notChecked += 1;
        continue;
      }
      budget -= 1;
      try {
        const access = await tracking.queueReadableByAccount(vhost, queue, options);
        if (access === "readable") readable.push(queue);
        else if (access === "unchecked") notChecked += 1;
      } catch (error) {
        if (!stoppedByDeadline(error)) throw error;
        stopped = true;
        notChecked += 1;
      }
    }
    if (readable.length > 0) findings.push({ vhost, readable, notChecked });
  }

  for (const finding of findings.slice(0, RABBITMQ_CAUTION_MAX_VHOSTS)) {
    const named = finding.readable.slice(0, RABBITMQ_CAUTION_NAMED_QUEUES);
    cautions.push(
      readableQueuesCaution(finding.vhost, named, finding.readable.length - named.length, finding.notChecked),
    );
  }
  if (findings.length > RABBITMQ_CAUTION_MAX_VHOSTS)
    cautions.push(readableQueuesInMoreVhosts(findings.length - RABBITMQ_CAUTION_MAX_VHOSTS));
  return cautions.map((message) => ({ message }));
}
