/**
 * The Kubernetes access review's switch and settings (docs/SEED_CONNECTIONS.md, "Kubernetes access review").
 *
 * The review asks the Kubernetes API, through a SubjectAccessReview, whether the signed-in identity provider subject
 * may do one thing: `get` the Secret a Kubernetes-discovered connection's credentials come from, or `update` Studio's
 * own Deployment, which makes a Studio admin. It authenticates with the pod's ServiceAccount token and uses it for
 * SubjectAccessReviews only; the Kubernetes database provider never reads that token.
 *
 * `KUBERNETES_ACCESS_REVIEW` switches it on. Unset, empty or a value that switches it off leaves Studio exactly as it
 * is without this module. A value Studio does not know counts as on, so a typo fails closed: the review gates what it
 * gates, admin comes only from it, and the boot preflight (`preflight.ts`) refuses to start and names the value.
 *
 * Each reader reads the environment on every call and throws an `AccessReviewConfigError` naming its variable when the
 * value is invalid, never quoting the value, instead of falling back to a default. The module imports no Node built-in,
 * so any server module can ask the switch.
 */
import type { ResourceAttributes } from "./review";

export const ACCESS_REVIEW_ENV = "KUBERNETES_ACCESS_REVIEW";
const API_URL_ENV = "KUBERNETES_ACCESS_REVIEW_API_URL";
const TOKEN_PATH_ENV = "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH";
const CA_PATH_ENV = "KUBERNETES_ACCESS_REVIEW_CA_PATH";
const CACHE_SECONDS_ENV = "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS";
const ADMIN_DEPLOYMENT_ENV = "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT";
const SIGN_IN_ENV = "KUBERNETES_ACCESS_REVIEW_SIGN_IN";

/** The in-cluster name of the Kubernetes API, which the API server's certificate carries. */
const DEFAULT_API_URL = "https://kubernetes.default.svc";
/** Where the kubelet mounts a pod's ServiceAccount token and the cluster's CA. */
const DEFAULT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
/**
 * Who may sign in: a cluster member. Rancher's NavLinks are readable to every role a cluster grants and to no one
 * without a role in the cluster (probe P12 on Rancher 2.15.2), which a review of the subject's own Secret access
 * cannot tell apart.
 */
const DEFAULT_SIGN_IN = "list navlinks.ui.cattle.io";
const DEFAULT_CACHE_SECONDS = 30;
const MAX_CACHE_SECONDS = 60;

/** A namespace name: an RFC 1123 label. */
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** A Deployment name, an object name or an API group: an RFC 1123 subdomain. */
const DEPLOYMENT_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const MAX_DEPLOYMENT_NAME = 253;
/** A resource's plural name: an RFC 1123 label. */
const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const VERB = /^([a-z]+|\*)$/;

const ON_VALUES = new Set(["on", "true", "1"]);
const OFF_VALUES = new Set(["off", "false", "0", ""]);

// One template literal per message, never a concatenation across lines: bun's line coverage under-counts the
// continuation lines of a message built that way.
const API_URL_FIX = "set it to the API server's https address, such as https://kubernetes.default.svc";
const CACHE_SECONDS_MESSAGE = `${CACHE_SECONDS_ENV} must be a whole number of seconds from 0 to ${MAX_CACHE_SECONDS}`;
const ADMIN_DEPLOYMENT_MISSING_MESSAGE = `${ADMIN_DEPLOYMENT_ENV} is not set: with the access review on, a Studio admin is whoever may update Studio's Deployment, so name it as <namespace>/<name>, such as libredb-studio/libredb-studio`;
const ADMIN_DEPLOYMENT_INVALID_MESSAGE = `${ADMIN_DEPLOYMENT_ENV} must name Studio's Deployment as <namespace>/<name>, such as libredb-studio/libredb-studio`;
const SIGN_IN_INVALID_MESSAGE = `${SIGN_IN_ENV} must be a review as kubectl auth can-i takes it, <verb> <resource>[.<group>][/<name>] [-n <namespace>], such as ${DEFAULT_SIGN_IN}`;

/** A setting the access review cannot run with. Its message names the variable and never quotes the value. */
export class AccessReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessReviewConfigError";
  }
}

/** Off, on, or set to a value Studio does not know, which counts as on. */
export type AccessReviewSwitch = "off" | "on" | "invalid";

export function accessReviewSwitch(): AccessReviewSwitch {
  const value = (process.env[ACCESS_REVIEW_ENV] ?? "").trim().toLowerCase();
  if (OFF_VALUES.has(value)) return "off";
  return ON_VALUES.has(value) ? "on" : "invalid";
}

/** True with the review on, and for an invalid switch too, so the server fails closed. */
export function accessReviewEnabled(): boolean {
  return accessReviewSwitch() !== "off";
}

/** The API server the reviews go to: an https URL without user info, query or fragment, with no trailing slash. */
export function accessReviewApiUrl(): URL {
  const raw = (process.env[API_URL_ENV] ?? "").trim() || DEFAULT_API_URL;
  const url = URL.parse(raw);
  if (url === null) throw new AccessReviewConfigError(`${API_URL_ENV} is not an absolute URL: ${API_URL_FIX}`);
  if (url.protocol !== "https:") throw new AccessReviewConfigError(`${API_URL_ENV} must use https: ${API_URL_FIX}`);
  if (url.username !== "" || url.password !== "") {
    throw new AccessReviewConfigError(`${API_URL_ENV} must not carry a user name or password`);
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new AccessReviewConfigError(`${API_URL_ENV} must not carry a query or a fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** The ServiceAccount token file, read again for every review, so a rotated token is used at once. */
export function accessReviewTokenPath(): string {
  return (process.env[TOKEN_PATH_ENV] ?? "").trim() || DEFAULT_TOKEN_PATH;
}

/** The CA bundle the API server's certificate must chain to, read again for every review. */
export function accessReviewCaPath(): string {
  return (process.env[CA_PATH_ENV] ?? "").trim() || DEFAULT_CA_PATH;
}

/** How long an allowed or denied answer is kept, in milliseconds; 0 keeps none. */
export function accessReviewCacheMs(): number {
  const raw = (process.env[CACHE_SECONDS_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_CACHE_SECONDS * 1000;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= 0 && seconds <= MAX_CACHE_SECONDS)) throw new AccessReviewConfigError(CACHE_SECONDS_MESSAGE);
  return seconds * 1000;
}

/** A Deployment by namespace and name. */
export interface DeploymentRef {
  readonly namespace: string;
  readonly name: string;
}

/** Studio's own Deployment: whoever may `update` it is a Studio admin while the review is on. */
export function accessReviewAdminDeployment(): DeploymentRef {
  const raw = (process.env[ADMIN_DEPLOYMENT_ENV] ?? "").trim();
  if (raw === "") throw new AccessReviewConfigError(ADMIN_DEPLOYMENT_MISSING_MESSAGE);
  const parts = raw.split("/");
  const [namespace, name] = parts;
  const valid =
    parts.length === 2 &&
    NAMESPACE_NAME.test(namespace) &&
    name.length <= MAX_DEPLOYMENT_NAME &&
    DEPLOYMENT_NAME.test(name);
  if (!valid) throw new AccessReviewConfigError(ADMIN_DEPLOYMENT_INVALID_MESSAGE);
  return { namespace, name };
}

/** Whether `value` is "" or an RFC 1123 subdomain of at most 253 characters. */
const optionalSubdomain = (value: string): boolean =>
  value === "" || (value.length <= MAX_DEPLOYMENT_NAME && DEPLOYMENT_NAME.test(value));

/**
 * The review a person must pass to sign in at all, from `KUBERNETES_ACCESS_REVIEW_SIGN_IN` in the form `kubectl auth
 * can-i` takes, `<verb> <resource>[.<group>][/<name>] [-n <namespace>]`; by default `list navlinks.ui.cattle.io` at
 * cluster scope, which only a member of the cluster may do on Rancher.
 */
export function accessReviewSignIn(): ResourceAttributes {
  const raw = (process.env[SIGN_IN_ENV] ?? "").trim() || DEFAULT_SIGN_IN;
  const tokens = raw.split(/\s+/);
  if (!(tokens.length === 2 || (tokens.length === 4 && tokens[2] === "-n"))) {
    throw new AccessReviewConfigError(SIGN_IN_INVALID_MESSAGE);
  }
  const [verb, target, , namespace = ""] = tokens;
  const [type, ...named] = target.split("/");
  const name = named.join("/");
  const [resource, ...group] = type.split(".");
  const valid =
    VERB.test(verb) &&
    RESOURCE_NAME.test(resource) &&
    optionalSubdomain(group.join(".")) &&
    (named.length === 0 || (name !== "" && optionalSubdomain(name))) &&
    (namespace === "" || NAMESPACE_NAME.test(namespace));
  if (!valid) throw new AccessReviewConfigError(SIGN_IN_INVALID_MESSAGE);
  return { verb, group: group.join("."), resource, namespace, name };
}
