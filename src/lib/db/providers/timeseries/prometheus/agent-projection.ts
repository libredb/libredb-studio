/**
 * What a Prometheus handle opened for an agent-mode profile keeps of the server's answers: the transport seam wrapped
 * so that every consumer above it (the object surface, the grounding walk, the monitoring readings) reads the projected
 * answer and nothing else.
 *
 * VALUES ARE ANSWERED. Metric samples, label values, rule and target state are the server's monitoring data, and the
 * agent reads them. Three things are not:
 *
 * - The server's command-line flags are withheld whole, before anything is sent: they carry file paths, listen
 *   addresses, URLs and local configuration, and no reading the agent takes needs them.
 * - Every URL a target, a rule or an alert answer carries keeps only its scheme, host, port and path: a scrape URL's
 *   query string carries the scrape parameters, a token among them, and a URL's userinfo carries a user name and a
 *   password, so neither, and no fragment, reaches an answer. That covers a target's scrape URL and last error, every
 *   label and discovered label, a rule's expression, labels and last error, an alert's labels and annotations, and
 *   every label of a series a PromQL answer carries (an `instance` built from an address with userinfo among them). A
 *   label value an expression rewrites (`label_replace`) so that it no longer reads as a URL or an address is not
 *   recognised, and is answered as the expression wrote it. An
 *   address written with userinfo (`user:password@host:port`, which a target's address can carry) keeps its host,
 *   port and path, and a URL with no scheme (`//host/path`) its host and path, never a query string or a fragment. A
 *   URL that does not parse, and a word whose `://` has no scheme in front of it, are withheld whole rather than cut
 *   by guesswork.
 * - Every scrape parameter among a target's discovered labels (`__param_<name>`) is withheld: it is the query string
 *   the scrape URL would carry, under another name.
 *
 * Projection is applied to the seam's decoded answer, so the names the object surface builds from it (a target's path
 * segment is its scrape URL and a digest of its labels) are built from the projected answer and carry nothing withheld,
 * not even as a digest. Every reason is a sentence here, which the agent's grounding repeats whether or not the run
 * connects. The editor's handles keep every answer as the server gave it.
 */
import type {
  PrometheusAlert,
  PrometheusAnswer,
  PrometheusQueryData,
  PrometheusRule,
  PrometheusRuleGroup,
  PrometheusTarget,
  PrometheusTransport,
} from "./transport";
import { PrometheusTransportError } from "./transport";

/** What an agent-mode handle withholds and why, in the words grounding and refusals repeat. */
export const PROMETHEUS_AGENT_PROJECTION = Object.freeze({
  /** Appended to a URL or an address that lost its userinfo, its query string or its fragment. */
  mark: "[userinfo, query string and fragment withheld]",
  /** Stands in for a URL that does not parse, so no part of it is guessed at. */
  unreadableUrl: "[URL withheld: it does not parse]",
  /** Stands in for the value of a scrape parameter among a target's discovered labels. */
  scrapeParameter: "[scrape parameter withheld]",
  flags:
    "Agent mode does not read the server's command-line flags: they carry file paths, listen addresses, URLs and local configuration, so they are withheld on every agent-mode reading. This is Studio's choice, not the server's answer.",
  urls: "Every URL a target, a rule, an alert or a PromQL answer's labels carry is kept to its scheme, host, port and path in agent mode, because a scrape URL's query string can carry a token and a URL's userinfo a user name and password; an address written with userinfo keeps its host, port and path, and every scrape parameter of a target is withheld.",
  /** What the projection cannot reach, named for the model beside what it withholds (B161). */
  residual:
    "The projection goes by a value's shape: a label value an expression rewrites with label_replace so that it no longer reads as a URL or an address is answered as rewritten, and a label matcher selects on the value the server stores, so never use either to read a value the projection withholds.",
});

/** Where a URL or an address inside free text ends: whitespace, and the characters RFC 3986 never lets one hold. */
const DELIMITERS: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", '"', "<", ">", "`", "{", "}", "|", "\\", "^"]);

/** The scrape parameters among a target's discovered labels: `__param_<name>`. */
const SCRAPE_PARAMETER_PREFIX = "__param_";

const SCHEME_SEPARATOR = "://";

function isSchemeCharacter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    (character >= "0" && character <= "9") ||
    character === "+" ||
    character === "-" ||
    character === "."
  );
}

function isLetter(character: string): boolean {
  return (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

/** One URL, from its scheme to the end of its word, kept to its scheme, host, port and path. */
function projectUrl(candidate: string): string {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return PROMETHEUS_AGENT_PROJECTION.unreadableUrl;
  }
  const kept = `${url.protocol}//${url.host}${url.pathname}`;
  const dropped =
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    candidate.includes("?") ||
    candidate.includes("#");
  return dropped ? `${kept} ${PROMETHEUS_AGENT_PROJECTION.mark}` : kept;
}

/** Where a query string or a fragment starts in a word, or the word's length when it holds neither. */
function queryStart(word: string): number {
  const query = word.indexOf("?");
  const fragment = word.indexOf("#");
  if (query < 0) return fragment < 0 ? word.length : fragment;
  return fragment < 0 ? query : Math.min(query, fragment);
}

/**
 * `user:password@host:port/path?query`, an address written with userinfo: its query string and fragment are dropped
 * first, so nothing after a `?` is kept even when it holds an `@`, and then everything up to the last `@`. When no `@`
 * is left once the query string is gone, the userinfo itself held the `?` or the `#`, and no address can be told from
 * it, so the word is withheld whole.
 */
function projectAddress(word: string): string {
  const address = word.slice(0, queryStart(word));
  const at = address.lastIndexOf("@");
  if (at < 0) return PROMETHEUS_AGENT_PROJECTION.unreadableUrl;
  return `${address.slice(at + 1)} ${PROMETHEUS_AGENT_PROJECTION.mark}`;
}

/**
 * `//host/path?query`, a URL with no scheme: read as an `http` URL and kept to its host and path, or left as written
 * when it carries nothing to drop. One that does not parse is withheld whole, like any other URL.
 */
function projectSchemeless(prefix: string, rest: string): string {
  let url: URL;
  try {
    url = new URL(`http:${rest}`);
  } catch {
    return `${prefix}${PROMETHEUS_AGENT_PROJECTION.unreadableUrl}`;
  }
  const dropped = url.username !== "" || url.password !== "" || queryStart(rest) < rest.length;
  return dropped ? `${prefix}//${url.host}${url.pathname} ${PROMETHEUS_AGENT_PROJECTION.mark}` : `${prefix}${rest}`;
}

/**
 * One word of free text: the URL inside it projected, an address with userinfo kept to its host and path, a URL with
 * no scheme kept to its host and path, and a word whose `://` has no scheme in front of it withheld whole, since no
 * reader can say where its userinfo or its query string ends.
 */
function projectWord(word: string): string {
  const separator = word.indexOf(SCHEME_SEPARATOR);
  if (separator >= 0) {
    let start = separator;
    while (start > 0 && isSchemeCharacter(word[start - 1])) start -= 1;
    // A scheme starts with a letter; anything before it is a prefix the word carries, such as `url=` or `(`.
    while (start < separator && !isLetter(word[start])) start += 1;
    // The prefix is projected too: it holds no `://`, but it can hold an address or a URL with no scheme.
    if (start < separator) return `${projectWord(word.slice(0, start))}${projectUrl(word.slice(start))}`;
    const bare = separator + SCHEME_SEPARATOR.length === word.length;
    return bare ? word : PROMETHEUS_AGENT_PROJECTION.unreadableUrl;
  }
  const at = word.lastIndexOf("@");
  // `user:password@host:port`: the colon before the last `@` is what tells userinfo from an e-mail address.
  if (at > 0 && word.slice(0, at).includes(":")) return projectAddress(word);
  const slashes = word.indexOf("//");
  if (slashes >= 0 && slashes + 2 < word.length) return projectSchemeless(word.slice(0, slashes), word.slice(slashes));
  return word;
}

/** Free text with every URL and every address with userinfo in it projected, and everything else as written. */
export function projectUrlText(text: string): string {
  let projected = "";
  let word = "";
  for (const character of text) {
    if (DELIMITERS.has(character)) {
      projected += projectWord(word) + character;
      word = "";
    } else {
      word += character;
    }
  }
  return projected + projectWord(word);
}

function projectLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([name, value]) => [
      name,
      name.startsWith(SCRAPE_PARAMETER_PREFIX) ? PROMETHEUS_AGENT_PROJECTION.scrapeParameter : projectUrlText(value),
    ]),
  );
}

export function projectTarget(target: PrometheusTarget): PrometheusTarget {
  return {
    ...target,
    scrapeUrl: projectUrlText(target.scrapeUrl),
    lastError: projectUrlText(target.lastError),
    labels: projectLabels(target.labels),
    discoveredLabels: projectLabels(target.discoveredLabels),
  };
}

function projectAlert(alert: PrometheusAlert): PrometheusAlert {
  return { ...alert, labels: projectLabels(alert.labels), annotations: projectLabels(alert.annotations) };
}

function projectRule(rule: PrometheusRule): PrometheusRule {
  const common = {
    query: projectUrlText(rule.query),
    labels: projectLabels(rule.labels),
    lastError: projectUrlText(rule.lastError),
  };
  if (rule.kind === "recording") return { ...rule, ...common };
  return {
    ...rule,
    ...common,
    annotations: projectLabels(rule.annotations),
    alerts: rule.alerts.map(projectAlert),
  };
}

export function projectRuleGroup(group: PrometheusRuleGroup): PrometheusRuleGroup {
  return { ...group, rules: group.rules.map(projectRule) };
}

/**
 * A PromQL answer with every series' labels projected as a target's are, its samples and notices as they came: an
 * `instance` built from an address with userinfo keeps its host and port, and a label holding a URL its scheme, host,
 * port and path. A scalar and a string carry no label.
 */
function projectQueryAnswer(answer: PrometheusAnswer<PrometheusQueryData>): PrometheusAnswer<PrometheusQueryData> {
  const data = answer.value;
  if (data.shape !== "vector" && data.shape !== "matrix") return answer;
  const series = data.series.map((entry) => ({ ...entry, labels: projectLabels(entry.labels) }));
  return { ...answer, value: { shape: data.shape, series } };
}

/**
 * The transport an agent-mode handle reads through: query answers, targets and rules projected, the flags withheld
 * before anything is sent, and every other read passed through as it is.
 */
export function projectAgentTransport(transport: PrometheusTransport): PrometheusTransport {
  return {
    query: async (...args) => projectQueryAnswer(await transport.query(...args)),
    metricNames: (...args) => transport.metricNames(...args),
    labelNames: (...args) => transport.labelNames(...args),
    seriesLabels: (...args) => transport.seriesLabels(...args),
    metadata: (...args) => transport.metadata(...args),
    rules: async (filter) => (await transport.rules(filter)).map(projectRuleGroup),
    scrapePools: () => transport.scrapePools(),
    targets: async (pool) => (await transport.targets(pool)).map(projectTarget),
    health: () => transport.health(),
    buildInfo: () => transport.buildInfo(),
    runtimeInfo: () => transport.runtimeInfo(),
    flags: () => Promise.reject(new PrometheusTransportError("withheld", PROMETHEUS_AGENT_PROJECTION.flags)),
    tsdbStatus: (...args) => transport.tsdbStatus(...args),
  };
}
