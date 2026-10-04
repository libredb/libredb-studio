/**
 * One connection attempt per case, as both runtimes run it: under Bun inside tests/unit/db/milvus/tls-handshake.test.ts,
 * and under Node in a child that runs a bundle of this module, so both run the same code against the same listeners.
 * A provider case takes a connection as the dialog or a seed writes it through `buildMilvusConnectionOptions`,
 * `createGrpcMilvusClient` over the real transport, one GetVersion, and `toProviderError`; a control case is
 * @grpc/grpc-js as it comes, with no override and no `dns:` scheme, which shows what the provider's rules prevent.
 */
import * as grpc from "@grpc/grpc-js";
import type { MethodDefinition } from "@grpc/proto-loader";
import {
  buildMilvusConnectionOptions,
  milvusErrorConnection,
} from "@/lib/db/providers/vector/milvus/connection-options";
import { toProviderError } from "@/lib/db/providers/vector/milvus/errors";
import { allowlistedService, createGrpcMilvusClient } from "@/lib/db/providers/vector/milvus/grpc-client";
import { TUNNEL_FAR_END } from "@/lib/types";

export type HandshakeCase =
  | {
      readonly name: string;
      readonly via: "provider";
      readonly connection: Record<string, unknown>;
      /** Set under TUNNEL_FAR_END: a symbol key does not survive JSON. */
      readonly farEnd?: { readonly host: string; readonly port: number };
      readonly timeoutMs: number;
    }
  | {
      readonly name: string;
      readonly via: "control";
      readonly target: string;
      readonly ca?: string;
      readonly timeoutMs: number;
    };

export type HandshakeOutcome =
  | { readonly name: string; readonly outcome: "connected" }
  | { readonly name: string; readonly outcome: "refused"; readonly errorClass: string; readonly message: string }
  | {
      readonly name: string;
      readonly outcome: "failed";
      readonly category?: string;
      readonly tlsFailure?: string;
      readonly errorClass?: string;
      readonly message?: string;
      readonly raw?: string;
    };

async function control(item: Extract<HandshakeCase, { via: "control" }>): Promise<HandshakeOutcome> {
  const channelCredentials =
    item.ca === undefined ? grpc.credentials.createInsecure() : grpc.credentials.createSsl(Buffer.from(item.ca));
  const client = new grpc.Client(item.target, channelCredentials, { "grpc.service_config_disable_resolution": 1 });
  const method = allowlistedService().GetVersion as MethodDefinition<object, object>;
  const failed = await new Promise<string | undefined>((resolve) => {
    client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      {},
      new grpc.Metadata(),
      { deadline: Date.now() + item.timeoutMs },
      (error) => resolve(error === null ? undefined : String(error.details)),
    );
  });
  client.close();
  return failed === undefined
    ? { name: item.name, outcome: "connected" }
    : { name: item.name, outcome: "failed", raw: failed };
}

async function provider(item: Extract<HandshakeCase, { via: "provider" }>): Promise<HandshakeOutcome> {
  let options: ReturnType<typeof buildMilvusConnectionOptions>;
  try {
    const connection =
      item.farEnd === undefined ? item.connection : { ...item.connection, [TUNNEL_FAR_END]: item.farEnd };
    options = buildMilvusConnectionOptions(connection as never, {
      executionReadOnly: false,
      queryTimeout: item.timeoutMs,
    });
  } catch (error) {
    const refusal = error as Error;
    return { name: item.name, outcome: "refused", errorClass: refusal.name, message: refusal.message };
  }
  const client = await createGrpcMilvusClient(options);
  try {
    await client.getVersion({ db: options.database, signal: new AbortController().signal });
    return { name: item.name, outcome: "connected" };
  } catch (error) {
    const failure = error as { readonly category?: string; readonly tlsFailure?: string };
    const mapped = toProviderError(error, {
      operation: "connection test",
      write: false,
      connection: milvusErrorConnection(options),
      secretForms: options.secretForms,
    });
    return {
      name: item.name,
      outcome: "failed",
      category: failure.category,
      ...(failure.tlsFailure === undefined ? {} : { tlsFailure: failure.tlsFailure }),
      errorClass: mapped.name,
      message: mapped.message,
    };
  } finally {
    client.close();
  }
}

export async function runHandshakeCases(cases: readonly HandshakeCase[]): Promise<HandshakeOutcome[]> {
  const outcomes: HandshakeOutcome[] = [];
  for (const item of cases) {
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time, so each listener's count is its case's alone.
    outcomes.push(item.via === "control" ? await control(item) : await provider(item));
  }
  return outcomes;
}
