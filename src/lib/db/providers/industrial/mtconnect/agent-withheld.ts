/**
 * What an MTConnect handle opened for an agent-mode profile withholds, and why.
 *
 * VALUES ARE ANSWERED. An observation's value, timestamp and sequence and an asset's document are the machine's own
 * data, so the agent reads them, rendered as the console renders them.
 *
 * ONE THING IS NOT: the agent's own adapter connections. MEASURED on the pinned fixture (`mtconnect/agent:2.8.0.4`)
 * and on the Institute's demo agent: the agent writes an `Adapters` component under its own Agent device and one
 * `Adapter` component per adapter it reads from, and that component's name (`shdr://mtconnect-adapter:7878`), its id
 * (`_mtconnect-adapter_7878`), every one of its data item ids (`_mtconnect-adapter_7878_adapter_uri`) and the
 * `ADAPTER_URI` observation's value carry the network address of another system, the adapter. No column of such an
 * observation can be shown without the address, so the whole observation is withheld, and so is the data item in
 * the device model and in the tree: the read answers what it withheld as a count, with this reason, never a row.
 *
 * Decided by the agent's own answer, never by a name list Studio guesses: an item is withheld when the device model
 * places it inside an `Adapters` or `Adapter` component (`MtcDataItem.withinAdapter`), and an observation when its
 * `<ComponentStream>` says it belongs to one, which also covers an adapter the model read before the observation did
 * not know yet. The agent's other items (its availability, the devices it added, changed or removed, its asset counts)
 * carry no address and are answered.
 *
 * NOR IS A URL'S SECRET IN AN ASSET. MEASURED on the pinned image with `AllowPut = true`: a File asset whose
 * `FileLocation href` carries a user name and password is stored and served by `/assets` exactly as written, so an
 * asset's document and attributes can carry whatever credential the system that wrote the asset put in a URL. Every
 * URL in an asset keeps its scheme, host, port, path and fragment, which say where a file is, and its user name,
 * password and query string, where a credential or a signature travels, read `[withheld]`; the answer counts them.
 * MEASURED on the same image with an MQTT sink configured: the broker's address reaches no route of the table.
 *
 * Browser-safe: no Node built-in, no server module.
 */
import { MTC_ADAPTER_COMPONENTS, type MtcDataItem } from "./model";
import type { MtcObservation } from "./xml";

/** Why the adapter items are withheld, in the words every answer and the grounding repeat. */
export const MTCONNECT_WITHHELD_SENTENCE =
  "Agent mode withholds the agent's own adapter connections, the Adapter components under its Agent device: their component names, their data item ids and their ADAPTER_URI values carry the network address of the adapter the agent reads from, so none of their observations or data items is answered or listed. Every other device, component and data item is read.";

/** The warning an answer carries for the observations or data items it withheld. */
export function withheldWarning(count: number, noun: "observation" | "data item"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"} of the agent's adapter connections ${count === 1 ? "was" : "were"} withheld from this answer. ${MTCONNECT_WITHHELD_SENTENCE}`;
}

/** Whether a data item of the model is withheld on an agent-mode handle. */
export function itemWithheld(item: MtcDataItem): boolean {
  return item.withinAdapter;
}

/** Whether an observation is withheld: its model item is, or its `<ComponentStream>` is an adapter's. */
export function observationWithheld(observation: MtcObservation, item: MtcDataItem | undefined): boolean {
  if (item?.withinAdapter === true) return true;
  return observation.componentType !== undefined && MTC_ADAPTER_COMPONENTS.has(observation.componentType);
}

/** Why a URL's user name, password and query string are withheld from an asset, in the words the warning repeats. */
const MTCONNECT_WITHHELD_URL_SENTENCE =
  "Agent mode keeps each URL in an asset to its scheme, host, port, path and fragment, and withholds its user name, password and query string, where a credential or a signature travels.";

/**
 * A URL: its scheme, then an optional user name and password ending in `@`, a host with its port, a path, and an
 * optional query string. A mail address or a path with no scheme is no URL here.
 */
const URL_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#@"'<>]*@)?([^\s/?#"'<>]*[^\s?#"'<>]*)(\?[^\s#"'<>]*)?/g;

/** `text` with every URL's user name, password and query string read `[withheld]`, and how many were withheld. */
export function withoutUrlSecrets(text: string): { readonly text: string; readonly withheld: number } {
  let withheld = 0;
  const kept = text.replace(URL_PATTERN, (_url, scheme: string, userinfo?: string, rest?: string, query?: string) => {
    if (userinfo !== undefined) withheld += 1;
    if (query !== undefined) withheld += 1;
    return `${scheme}${userinfo === undefined ? "" : "[withheld]@"}${rest}${query === undefined ? "" : "?[withheld]"}`;
  });
  return { text: kept, withheld };
}

/** The warning an asset answer carries for the user names, passwords and query strings it withheld. */
export function withheldUrlWarning(count: number): string {
  return count === 1
    ? `1 user name, password or query string of a URL in an asset was withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`
    : `${count} user names, passwords or query strings of URLs in assets were withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`;
}
