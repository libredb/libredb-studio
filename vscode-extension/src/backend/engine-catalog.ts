// The engine catalogue engines/list answers (part 2, "Where each per-engine fact comes from"): each engine the
// add-connection flow offers, with the form facts LibreDB declares for it.
// The form table and the connection-string rows value-import modules that live beside the providers, so only the
// child bundles this module; it constructs no provider.
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";
import { CONNECTION_FORM_URI_MODE, isExternalDatabaseType } from "@/lib/db/compatibility";
import {
  CONNECTION_FIELDS,
  type ConnectionField,
  PLACEABLE_FIELDS,
  type PlaceableField,
} from "@/lib/db/connection-fields";
import {
  CONNECTION_FORM,
  CONNECTION_PICKER_ORDER,
  type ConnectionFormSpec,
  connectionFieldHint,
  connectionFieldLabel,
  connectionFieldPlaceholder,
  connectionFieldPlacement,
  offersSslPanel,
} from "@/lib/db/connection-form";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import type { DatabaseType } from "@/lib/types";
import type { EngineCatalog, EngineField, EngineForm } from "../protocol";

const PLACEABLE: ReadonlySet<ConnectionField> = new Set(PLACEABLE_FIELDS);

function isPlaceable(field: ConnectionField): field is PlaceableField {
  return PLACEABLE.has(field);
}

/** An empty or absent text as null, so the wire says "none declared" one way. */
function declared(text: string | undefined): string | null {
  return text === undefined || text === "" ? null : text;
}

function engineField(spec: ConnectionFormSpec, name: ConnectionField): EngineField {
  return {
    name,
    label: declared(connectionFieldLabel(spec, name, "")),
    hint: declared(connectionFieldHint(spec, name)),
    placeholder: declared(connectionFieldPlaceholder(spec, name, "")),
    placement: isPlaceable(name) ? connectionFieldPlacement(spec, name) : "open",
  };
}

/** One engine's form facts as engines/list carries them; constructs no provider. */
export function engineForm(type: DatabaseType): EngineForm {
  const spec: ConnectionFormSpec = CONNECTION_FORM[type];
  return {
    type,
    label: spec.label,
    // "" is a declaration of its own: the Host box opens empty rather than keeping what it held.
    defaultHost: spec.defaultHost ?? null,
    defaultPort: spec.defaultPort,
    pasteScheme: CONNECTION_STRING[type].scheme,
    keepsPastedString: CONNECTION_FORM_URI_MODE[type],
    offersSsl: offersSslPanel(type),
    fields: CONNECTION_FIELDS[type].map((name) => engineField(spec, name)),
  };
}

/**
 * CONNECTION_PICKER_ORDER, kept where the type is external and, when enabled is not null, in it: the list
 * enabledProviderTypes() parses for the factory's refusal keeps a type out here too.
 */
export function engineCatalog(enabled: readonly DatabaseType[] | null): EngineCatalog {
  const allowed = enabled === null ? null : new Set(enabled);
  return {
    engines: CONNECTION_PICKER_ORDER.filter(
      (type) => isExternalDatabaseType(type) && (allowed === null || allowed.has(type)),
    ).map(engineForm),
    pasteFormats: PASTE_FORMATS_TEXT,
  };
}
