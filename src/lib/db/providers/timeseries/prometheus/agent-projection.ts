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
 *   label and discovered label, a rule's expression, labels and last error, and an alert's labels and annotations. An
 *   address written with userinfo (`user:password@host:port`, which a target's address can carry) keeps its host and
 *   port. A URL that does not parse is withheld whole rather than cut by guesswork.
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
  urls: "Every URL a target, a rule or an alert carries is kept to its scheme, host, port and path in agent mode, because a scrape URL's query string can carry a token and a URL's userinfo a user name and password; an address written with userinfo keeps its host and port, and every scrape parameter of a target is withheld.",
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

/** One word of free text: the URL inside it projected, or an address with userinfo kept to its host. */
function projectWord(word: string): string {
  const separator = word.indexOf(SCHEME_SEPARATOR);
  if (separator > 0) {
    let start = separator;
    while (start > 0 && isSchemeCharacter(word[start - 1])) start -= 1;
    // A scheme starts with a letter; anything before it is a prefix the word carries, such as `url=` or `(`.
    while (start < separator && !isLetter(word[start])) start += 1;
    if (start < separator) return `${word.slice(0, start)}${projectUrl(word.slice(start))}`;
  }
  const at = word.lastIndexOf("@");
  // `user:password@host:port`: the colon before the last `@` is what tells userinfo from an e-mail address.
  if (at > 0 && word.slice(0, at).includes(":") && !word.includes(SCHEME_SEPARATOR)) {
    return `${word.slice(at + 1)} ${PROMETHEUS_AGENT_PROJECTION.mark}`;
  }
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
 * The transport an agent-mode handle reads through: targets and rules projected, the flags withheld before anything
 * is sent, and every other read passed through as it is.
 */
export function projectAgentTransport(transport: PrometheusTransport): PrometheusTransport {
  return {
    query: (...args) => transport.query(...args),
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
