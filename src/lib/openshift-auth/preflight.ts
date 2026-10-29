/**
 * Boot checks of openshift sign-in (NEXT_PUBLIC_AUTH_PROVIDER=openshift), run by src/lib/config/auth-preflight.ts.
 *
 * In the mode, every reason the environment contradicts it, so one banner names every variable to fix: an invalid
 * configuration variable or file, a password (the cluster is the only way in), an identity provider role variable
 * (roles come only from Kubernetes reviews) and MCP or the agent switched on (both are held in this mode). Outside
 * the mode, the three identity variables an operator sets only to run it. Every message names variables only, never a
 * value, a path or a secret.
 */

import { authProviderSetting } from "@/lib/config/auth-provider";
import {
  OPENSHIFT_API_CA_FILE_ENV,
  OPENSHIFT_CLIENT_ID_ENV,
  OPENSHIFT_PUBLIC_URL_ENV,
  OPENSHIFT_TOKEN_FILE_ENV,
  openShiftApiCaFilePath,
  openShiftApiUrl,
  openShiftClientId,
  openShiftPublicUrl,
  openShiftTokenFilePath,
} from "@/lib/openshift-auth/config";
import { readCertificateFile, tokenFileReady } from "@/lib/openshift-auth/files";

const TOKEN_FILE_PROBLEM = `${OPENSHIFT_TOKEN_FILE_ENV} names a file that is missing, unreadable or empty: mount the projected ServiceAccount token Studio presents as its client secret there`;
const CA_FILE_PROBLEM = `${OPENSHIFT_API_CA_FILE_ENV} names a file that cannot be read or holds no certificate: mount the cluster CA there, the ca.crt key of the kube-root-ca.crt ConfigMap`;

/** The switch values that leave MCP and the agent off, as the Kubernetes access review preflight reads them. */
const SWITCH_OFF = new Set(["false", "off", "0"]);

/** The variables an operator sets only for this mode; the API URL and CA file have defaults, so they are not listed. */
const IDENTITY_VARIABLES = [OPENSHIFT_CLIENT_ID_ENV, OPENSHIFT_TOKEN_FILE_ENV, OPENSHIFT_PUBLIC_URL_ENV] as const;

/** The message of the error `read` throws, or null when it reads. */
function refusalOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function tokenFileProblem(): string | null {
  let path: string;
  try {
    path = openShiftTokenFilePath();
  } catch (error) {
    return (error as Error).message;
  }
  return tokenFileReady(path) ? null : TOKEN_FILE_PROBLEM;
}

/** Every reason the environment contradicts openshift sign-in, each starting with the variable to fix. */
export function openShiftAuthEnvProblems(): string[] {
  const problems: (string | null)[] = [
    refusalOf(openShiftClientId),
    refusalOf(openShiftPublicUrl),
    refusalOf(openShiftApiUrl),
    tokenFileProblem(),
    readCertificateFile(openShiftApiCaFilePath()) === null ? CA_FILE_PROBLEM : null,
  ];
  // An empty password counts as unset, as it does for sign-in (src/lib/local-auth.ts).
  for (const name of ["ADMIN_PASSWORD", "USER_PASSWORD"] as const) {
    if (process.env[name]) {
      problems.push(`${name} is set: openshift sign-in signs people in through the cluster only, so unset it`);
    }
  }
  for (const name of ["OIDC_ROLE_CLAIM", "OIDC_ADMIN_ROLES", "OIDC_USER_ROLES", "OIDC_ROLE_PREFIX"] as const) {
    if (process.env[name]?.trim()) {
      problems.push(
        `${name} is set: in openshift sign-in a role comes only from Kubernetes reviews, never from a claim, so unset it`,
      );
    }
  }
  for (const [name, feature] of [
    ["LIBREDB_MCP_ENABLED", "MCP"],
    ["LIBREDB_AGENT_ENABLED", "the agent"],
  ] as const) {
    const switched = (process.env[name] ?? "").trim().toLowerCase();
    if (switched !== "" && !SWITCH_OFF.has(switched)) {
      problems.push(
        `${name} is switched on: openshift sign-in holds ${feature}, whose credentials cannot carry the user's cluster sign-in, so set it to false or unset it`,
      );
    }
  }
  return problems.filter((problem): problem is string => problem !== null);
}

/** The identity variables of this mode that are set while another mode is on: the operator meant this mode. */
export function strayOpenShiftVariables(): string[] {
  if (authProviderSetting() === "openshift") return [];
  return IDENTITY_VARIABLES.filter((name) => (process.env[name] ?? "").trim() !== "");
}
