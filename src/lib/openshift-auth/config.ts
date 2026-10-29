/**
 * The configuration of `openshift` sign-in mode (NEXT_PUBLIC_AUTH_PROVIDER=openshift): Studio's own ServiceAccount is
 * the OAuth client of the cluster's built-in OAuth server, and its projected token is the client secret.
 *
 * Every getter reads the environment on every call and throws OpenShiftConfigError on an invalid value, never falling
 * back; a message names the variable and never quotes the value. No Node built-in is imported, because the proxy
 * imports the path constants. The OpenShift facts of the mode live here and in `identity.ts`; the OAuth 2.0 files
 * (`flow.ts`, `state.ts`, `metadata.ts`) hold none.
 */

import { AuthConfigError } from "@/lib/auth-errors";
import { getBasePath } from "@/lib/config/base-path";

export const OPENSHIFT_CLIENT_ID_ENV = "OPENSHIFT_OAUTH_CLIENT_ID";
export const OPENSHIFT_TOKEN_FILE_ENV = "OPENSHIFT_OAUTH_TOKEN_FILE";
export const OPENSHIFT_API_URL_ENV = "OPENSHIFT_API_URL";
export const OPENSHIFT_API_CA_FILE_ENV = "OPENSHIFT_API_CA_FILE";
export const OPENSHIFT_PUBLIC_URL_ENV = "OPENSHIFT_PUBLIC_URL";

/** The only place the scope is written: one more scope turns the user's own access review off (denied everywhere). */
export const OPENSHIFT_SCOPE = "user:info user:check-access";
export const OPENSHIFT_LOGIN_PATH = "/api/auth/openshift/login";
export const OPENSHIFT_CALLBACK_PATH = "/api/auth/openshift/callback";

const DEFAULT_API_URL = "https://kubernetes.default.svc";
const DEFAULT_API_CA_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

const CLIENT_ID_MESSAGE = `${OPENSHIFT_CLIENT_ID_ENV} must be system:serviceaccount:<namespace>:<name>, naming the ServiceAccount Studio runs as`;
const PUBLIC_URL_MESSAGE = `${OPENSHIFT_PUBLIC_URL_ENV} must be the https URL people open Studio at, with no user name, password, query or fragment and no path other than the base path`;
const API_URL_MESSAGE = `${OPENSHIFT_API_URL_ENV} must be an https URL with no user name, password, query or fragment; unset, it is the in-cluster API server`;
const TOKEN_FILE_MESSAGE = `${OPENSHIFT_TOKEN_FILE_ENV} must be the absolute path of the projected ServiceAccount token Studio presents to the OAuth server as its client secret`;

/** A namespace name: an RFC 1123 label of at most 63 characters. */
const NAMESPACE = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A ServiceAccount name: an RFC 1123 subdomain as Kubernetes checks it (no per-label bound); its length is checked apart. */
const NAME_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const CLIENT_ID_PATTERN = new RegExp(`^system:serviceaccount:${NAMESPACE}:(${NAME_LABEL}(?:\\.${NAME_LABEL})*)$`);
const MAX_NAME_LENGTH = 253;
/** The longest client id: the prefix, a 63-character namespace, the colon and a 253-character name. */
const MAX_CLIENT_ID_LENGTH = "system:serviceaccount:".length + 63 + 1 + MAX_NAME_LENGTH;

/** A setting openshift sign-in cannot run with; an AuthConfigError, so the login routes answer `openshift_config`. */
export class OpenShiftConfigError extends AuthConfigError {
  constructor(message: string) {
    super(message);
    this.name = "OpenShiftConfigError";
  }
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** The OAuth client id: Studio's ServiceAccount as `system:serviceaccount:<namespace>:<name>`. */
export function openShiftClientId(): string {
  const value = trimmed(process.env[OPENSHIFT_CLIENT_ID_ENV]);
  // The length bound runs first, so the pattern never scans an unbounded value.
  const match = value.length > MAX_CLIENT_ID_LENGTH ? null : CLIENT_ID_PATTERN.exec(value);
  if (match === null || match[1].length > MAX_NAME_LENGTH) throw new OpenShiftConfigError(CLIENT_ID_MESSAGE);
  return value;
}

/** An https URL without user info, query or fragment; `raw` catches an empty query or fragment the parser reports as "". */
export function httpsUrl(raw: string): URL | null {
  const url = URL.parse(raw);
  if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) return null;
  return url;
}

/**
 * The URL people open Studio at: its path, after one trailing slash is dropped, must equal the build's base path. Every
 * Studio redirect of this mode and the OAuth `redirect_uri` are built from it, never from a request header.
 */
export function openShiftPublicUrl(): URL {
  const url = httpsUrl(trimmed(process.env[OPENSHIFT_PUBLIC_URL_ENV]));
  const path = url?.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url?.pathname;
  if (url === null || path !== getBasePath()) throw new OpenShiftConfigError(PUBLIC_URL_MESSAGE);
  url.pathname = path === "" ? "/" : path;
  return url;
}

/** The `redirect_uri`: the public URL plus the callback path. */
export function openShiftCallbackUrl(): string {
  return `${openShiftPublicUrl().origin}${getBasePath()}${OPENSHIFT_CALLBACK_PATH}`;
}

/** The API server the metadata and users/~ calls go to, with no trailing slash; its own path prefix is kept. */
export function openShiftApiUrl(): URL {
  const url = httpsUrl(trimmed(process.env[OPENSHIFT_API_URL_ENV]) || DEFAULT_API_URL);
  if (url === null) throw new OpenShiftConfigError(API_URL_MESSAGE);
  url.pathname = withoutTrailingSlashes(url.pathname);
  return url;
}

/** `path` without its trailing slashes, in one pass: a pattern such as `\/+$` backtracks over a run of slashes. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/** A Windows absolute path: a leading separator, or a drive letter, a colon and a separator (`C:x` is drive-relative). */
const WINDOWS_ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/**
 * Whether `path` is absolute on the platform the server runs on, answered as `path.isAbsolute` answers it there, which
 * this module cannot import. A leading slash alone would refuse every Windows path, so openshift sign-in could not run
 * from npx or the Windows launcher.
 */
function isAbsolutePath(path: string): boolean {
  return process.platform === "win32" ? WINDOWS_ABSOLUTE_PATH.test(path) : path.startsWith("/");
}

/**
 * The projected token file used as the client secret. No default: the default ServiceAccount token carries the API
 * audience, which a dedicated audience replaces.
 */
export function openShiftTokenFilePath(): string {
  const value = trimmed(process.env[OPENSHIFT_TOKEN_FILE_ENV]);
  if (!isAbsolutePath(value)) throw new OpenShiftConfigError(TOKEN_FILE_MESSAGE);
  return value;
}

/** The cluster CA file: the only trust of every API call and part of the token call's trust. */
export function openShiftApiCaFilePath(): string {
  return trimmed(process.env[OPENSHIFT_API_CA_FILE_ENV]) || DEFAULT_API_CA_FILE;
}
