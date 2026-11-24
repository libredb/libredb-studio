/**
 * The one way a test writes DB_HTTP_BLOCK_PRIVATE_HOSTS in its own process.
 *
 * Studio reads the variable once per process and keeps the decision (`src/lib/db/egress-decision.ts`), so a plain
 * write after the first read moves nothing. These helpers write the variable and forget the kept decision, so the next
 * read decides as a new process started with that value would. A child process's environment needs neither: a child
 * decides for itself.
 */
import { forgetEgressDecision } from "@/lib/db/egress-decision";

/** Sets the variable, or deletes it for `undefined`, then forgets the kept decision. */
export function setEgressFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  else process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = value;
  forgetEgressDecision();
}

/** Sets the variable for `body`, then restores the value it found, forgetting the decision both times. */
export async function withEgressFlag<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  setEgressFlag(value);
  try {
    return await body();
  } finally {
    setEgressFlag(previous);
  }
}
