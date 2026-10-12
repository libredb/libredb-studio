# RabbitMQ Provider

Read-only access to one RabbitMQ broker: virtual hosts, streams, queues and exchanges over the management HTTP API, and a bounded, non-destructive read of a stream's messages over AMQP 0-9-1 (issue #1656).

## Object edit (#789): nothing to write

RabbitMQ declares no editable object kind and no write path.
Studio sends the broker GET requests and stream reads only, never a publish or a take, so object edit is not a decision a setting could reverse.
