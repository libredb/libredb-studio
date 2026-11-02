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
 * asset's document and attributes can carry whatever credential the system that wrote the asset put in a URL. A URL
 * keeps its scheme and, after its user information, its host, port and path, which say where a file is; its user name
 * and password, its query string and its fragment, where a credential, a signature or a token travels, read
 * `[withheld]`, and the answer counts them. The cut is made by position, never by parsing the URL, and leans to
 * withholding more: the values are decoded text, in which a password may hold an `@`, a quote, a slash, a `#`, a `?`
 * or a space that a URL client still sends, so everything from the first `://` in a value to the last `@` after it
 * is withheld, and so is everything from the first `?` or `#` after that to the end of the value.
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

/** Why a URL's user name, password, query string and fragment are withheld from an asset, in the words the warning repeats. */
const MTCONNECT_WITHHELD_URL_SENTENCE =
  "Agent mode keeps each URL in an asset to its scheme, host, port and path, and withholds everything from its :// to the last @ in the value, its user name and password, and everything from the first ? or # after that to the end of the value, its query string and fragment, where a credential, a signature or a token travels.";

/**
 * `text` with its URL secrets read `[withheld]`, and how many parts were withheld. A URL is a `://`; a mail address
 * or a path with no `://` is left as written.
 */
export function withoutUrlSecrets(text: string): { readonly text: string; readonly withheld: number } {
  const authority = text.indexOf("://");
  if (authority === -1) return { text, withheld: 0 };
  const start = authority + "://".length;
  const at = text.lastIndexOf("@");
  const userinfo = at >= start;
  const head = `${text.slice(0, start)}${userinfo ? "[withheld]@" : ""}`;
  const rest = text.slice(userinfo ? at + 1 : start);
  const tail = rest.search(/[?#]/);
  if (tail === -1) return { text: `${head}${rest}`, withheld: userinfo ? 1 : 0 };
  return { text: `${head}${rest.slice(0, tail + 1)}[withheld]`, withheld: userinfo ? 2 : 1 };
}

/** The warning an asset answer carries for the user names and passwords, query strings and fragments it withheld. */
export function withheldUrlWarning(count: number): string {
  return count === 1
    ? `1 user name and password, query string or fragment of a URL in an asset was withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`
    : `${count} user names and passwords, query strings or fragments of URLs in assets were withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`;
}
