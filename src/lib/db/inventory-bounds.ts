/**
 * How much of a database ONE inventory read may take, wherever that read is issued from (#789).
 *
 * Two readers, one owner. `POST /api/db/objects/inventory` bounds the object browser's read
 * with these, and `readObjectInventoryForGrounding()` in `src/lib/agent/tools.ts` bounds a
 * run's grounding walk with them; both report a bound with the same sentence, so a reader who
 * meets "inventory limit reached" in the agent rail and in the object browser meets one fact.
 * They were declared twice, once in each module, with a comment in the agent copy saying why:
 * `src/lib/api/object-route.ts` imports `next/server` at its top level, and pulling the request
 * layer into the agent tree to read two integers is a dependency nobody wants. This file is the
 * shared home that removes the reason - it imports nothing - so neither reader owns the numbers
 * and they cannot drift apart.
 *
 * `docs/AGENT.md` and `docs/API_DOCS.md` both state them, and the values are theirs to follow.
 */

/** The hard ceiling on the objects one inventory read returns. Never a caller parameter. */
export const INVENTORY_LIMIT = 5000;

/** The sentence the object bound is reported with, in both readers. */
export const INVENTORY_TRUNCATION_REASON = "inventory limit reached";

/**
 * The hard ceiling on the LISTINGS one inventory read issues, one per container and kind.
 *
 * `INVENTORY_LIMIT` bounds what comes back and does not bound the work done to get it: a body
 * naming fifty thousand container paths buys fifty thousand sequential round trips, each taking a
 * pool client, under a single rate-limit token, and every one of them may legitimately answer zero
 * objects so the object budget never advances. Nothing else in this app limits a request body, so
 * this is the only bound in that path.
 *
 * 1000, which is 142 containers at the seven kinds PostgreSQL declares. It only ever bites on a
 * fan-out of near-empty containers: at any real object density `INVENTORY_LIMIT` is reached first,
 * because 142 containers holding an average of 36 objects already saturates it. That is the
 * amplification this bounds, rather than a claim about how many schemas a database may have.
 */
export const INVENTORY_PAIR_LIMIT = 1000;

/** The sentence the pair bound is reported with, in both readers. */
export const PAIR_TRUNCATION_REASON = "container and kind pair limit reached";
