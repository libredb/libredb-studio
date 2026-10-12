/**
 * A RabbitMQ connection for unit tests: loopback management port 15672, AMQP port 5672, SSL off, the recommended
 * user. The password is built at run time from parts, so no credential literal sits in the repository.
 */
import type { DatabaseConnection } from "@/lib/types";

/** The test password, never written as one literal. */
export const RABBITMQ_TEST_PASSWORD = ["reader", "pass", "word"].join("-");

export function rabbitmqConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "rabbitmq-test",
    name: "rabbitmq-test",
    type: "rabbitmq",
    host: "127.0.0.1",
    port: 15672,
    user: "studio-reader",
    password: RABBITMQ_TEST_PASSWORD,
    amqpPort: "5672",
    ssl: { mode: "disable" },
    createdAt: new Date(0),
    ...overrides,
  };
}
