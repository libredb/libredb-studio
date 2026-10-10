/**
 * The YAML view of a built-in object: one GET of the object as JSON, redacted (Secret data, the last-applied
 * annotation of a Secret, `managedFields` of every object), then written as YAML by Studio. The server's own YAML
 * rendering is never asked for, so nothing reaches the view before redaction has run.
 */
import { stringify } from "yaml";
import { QueryError } from "@/lib/db/errors";
import { applySourceBound } from "@/lib/db/object-kinds";
import type { ObjectSourceDocument } from "@/lib/db/types";
import { findResource, withTypeRefresh } from "./discovery";
import { KubernetesRequestError, notServedSentence } from "./errors";
import { CLUSTER_CONTAINER } from "./kinds";
import { KUBERNETES_TYPE } from "./limits";
import { type KubernetesSurface, objectAddress } from "./objects";
import { readsSecrets, redactResponse } from "./redaction";

export async function readKubernetesSource(
  surface: KubernetesSurface,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const { container, entry, name } = objectAddress(path, kind);
  return withTypeRefresh(surface.discovery, async (index) => {
    const served = findResource(index, entry.group, entry.id);
    if (served === undefined || !served.verbs.includes("get"))
      throw new QueryError(
        notServedSentence(entry.labelPlural, { resource: entry.id, group: entry.group }),
        KUBERNETES_TYPE,
      );
    const body = await surface.client
      .json(
        { op: "get", target: served, ...(container === CLUSTER_CONTAINER ? {} : { namespace: container }), name },
        surface.call(),
      )
      .catch((error: unknown) => {
        // A missing object is named by its stored segment (`pod/web`), the address the tree and the caller hold.
        if (!(error instanceof KubernetesRequestError) || error.status !== 404 || error.typeMissing) throw error;
        const where = container === CLUSTER_CONTAINER ? "in the cluster" : `in the namespace ${container}`;
        throw new KubernetesRequestError(
          `${path[1]} was not found ${where} (404 Not Found).`,
          404,
          error.reason,
          false,
        );
      });
    const text = stringify(redactResponse(served, body), { aliasDuplicateObjects: false, lineWidth: 0 });
    const bounded = applySourceBound(text, limit);
    return {
      path: [...path],
      kind,
      parts: [
        {
          id: "yaml",
          label: "YAML",
          text: bounded.text,
          language: "yaml",
          // A Secret's view has its values removed, so it is never the whole object.
          form: readsSecrets(served) ? "partial" : "complete",
          origin: "rendered",
          ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
        },
      ],
    };
  });
}
