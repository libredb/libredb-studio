/**
 * The one take in the RabbitMQ live check: a no-ack `basic.get` of one message, the read-only check's control.
 *
 * The oracle compares every classic and quorum queue's delivery counters before and after a run of the provider, and
 * a comparison that cannot move proves nothing. So after the comparison this helper takes the canary's one message
 * as the same read-only account the provider ran as, and the check requires `queue_get_total` to move by exactly 1.
 * It lives here, test-only, because the provider has no encoder for `basic.get` and must never gain one;
 * `tests/unit/db/rabbitmq/live-environment.test.ts` asserts that no `src/` module imports this file.
 */
import { ByteReader, methodFrame, methodId, type TestAmqpTarget, TestAmqpConnection } from "./rabbitmq-test-amqp091";

export type BasicGetOutcome =
  | { readonly kind: "get-ok"; readonly body: Uint8Array; readonly messageCount: number }
  | { readonly kind: "get-empty" };

/** Opens a connection to `target`, sends one `basic.get` with no-ack on `queue`, reads the answer and closes. */
export async function basicGetOnce(target: TestAmqpTarget, queue: string): Promise<BasicGetOutcome> {
  const connection = await TestAmqpConnection.open(target);
  try {
    connection.send(methodFrame(1, 60, 70, (w) => w.u16(0).shortstr(queue).u8(1)));
    const answer = await connection.next();
    const id = methodId(answer.payload);
    if (id.classId === 60 && id.methodId === 72) return { kind: "get-empty" };
    if (id.classId !== 60 || id.methodId !== 71)
      throw new Error(`expected get-ok or get-empty, got ${id.classId}.${id.methodId}`);
    const reader = new ByteReader(answer.payload).skip(4);
    reader.u64();
    reader.u8();
    reader.shortstr();
    reader.shortstr();
    const messageCount = reader.u32();
    const header = await connection.next();
    const bodySize = Number(new ByteReader(header.payload).skip(4).u64());
    const parts: Uint8Array[] = [];
    let received = 0;
    while (received < bodySize) {
      const part = await connection.next();
      parts.push(part.payload);
      received += part.payload.length;
    }
    const body = new Uint8Array(received);
    let at = 0;
    for (const part of parts) {
      body.set(part, at);
      at += part.length;
    }
    return { kind: "get-ok", body, messageCount };
  } finally {
    await connection.close();
  }
}
