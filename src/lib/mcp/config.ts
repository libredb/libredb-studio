/**
 * The MCP server's configuration (#246): four variables, read from process.env on every call, as
 * src/lib/agent/config.ts reads its own, so a changed value is seen by the next request, and the
 * governance hold, which keeps MCP off in governance mode whatever those variables say.
 *
 * A problem names its variable and the rule it broke and never quotes the configured value: the
 * status endpoint shows problems to every signed-in user, and a URL can carry credentials in its
 * user info. The two channel values have no silent default. The URL is the audience every token
 * is bound to, and it must come from configuration, never from a request's Host, which under DNS
 * rebinding is the attacker's name.
 */
import { governanceEnabled } from "@/lib/governance/config";

export const MCP_PATH = "/api/mcp";
export const MCP_ENABLED_ENV = "LIBREDB_MCP_ENABLED";
export const MCP_URL_ENV = "LIBREDB_MCP_URL";
export const MCP_TOKEN_LABEL_ENV = "LIBREDB_MCP_TOKEN_LABEL";
export const MCP_TOKEN_TTL_DAYS_ENV = "LIBREDB_MCP_TOKEN_TTL_DAYS";
export const MCP_TOKEN_TTL_DAYS_DEFAULT = 30;
export const MCP_TOKEN_TTL_DAYS_MAX = 365;

export const MCP_ENABLED_INVALID_MESSAGE =
  "LIBREDB_MCP_ENABLED has an unrecognized value; use true, on or 1 to enable MCP, or false, off or 0 to disable it";

/** The spellings of src/lib/security/config.ts; an empty value is off too. */
const ON_VALUES = new Set(["true", "on", "1"]);
const OFF_VALUES = new Set(["false", "off", "0", ""]);

const SWITCH_OFF_PROBLEM = `${MCP_ENABLED_ENV} is off: set it to true, on or 1 to enable MCP`;
const GOVERNANCE_HOLD_PROBLEM = `GOVERNANCE_SOURCE is set: this version of Studio does not run MCP under governance, so MCP stays off whatever ${MCP_ENABLED_ENV} says`;
const URL_FIX = "set it to the address clients use, such as https://studio.example.com/api/mcp";

export type McpSwitchReading =
  | { readonly state: "on" }
  | { readonly state: "off" }
  | { readonly state: "invalid"; readonly raw: string };

export type McpSetting<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

export interface McpChannelStatus {
  readonly state: "off" | "misconfigured" | "ready";
  readonly problems: readonly string[];
  readonly url: string | null;
  readonly tokenTtlDays: number | null;
}

export class McpConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "McpConfigError";
  }
}

/**
 * Whether governance mode holds MCP off (docs/GOVERNANCE.md). This version does not run MCP under
 * governance: a token carries no identity provider subject to resolve its owner's grants by. So with
 * GOVERNANCE_SOURCE set the switch answers off, the endpoint answers 404 and no token is minted,
 * also where the boot preflight that refuses LIBREDB_MCP_ENABLED was bypassed. The switch and the
 * governance status both ask this one predicate, so the release that runs MCP under governance
 * lifts the hold here.
 */
export function isMcpHeldByGovernance(): boolean {
  return governanceEnabled();
}

export function readMcpSwitch(): McpSwitchReading {
  if (isMcpHeldByGovernance()) return { state: "off" };
  const raw = process.env[MCP_ENABLED_ENV] ?? "";
  const value = raw.trim().toLowerCase();
  if (OFF_VALUES.has(value)) return { state: "off" };
  if (ON_VALUES.has(value)) return { state: "on" };
  return { state: "invalid", raw };
}

function refused(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem };
}

export function readMcpUrl(): McpSetting<string> {
  const raw = (process.env[MCP_URL_ENV] ?? "").trim();
  if (raw === "") return refused(`${MCP_URL_ENV} is not set: ${URL_FIX}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused(`${MCP_URL_ENV} is not an absolute URL: ${URL_FIX}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refused(`${MCP_URL_ENV} must use http or https`);
  if (url.username !== "" || url.password !== "")
    return refused(`${MCP_URL_ENV} must not carry a user name or password`);
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return refused(`${MCP_URL_ENV} must not carry a query or a fragment`);
  }
  if (!url.pathname.endsWith(MCP_PATH)) return refused(`${MCP_URL_ENV} must end in /api/mcp, with no trailing slash`);
  return { ok: true, value: `${url.origin}${url.pathname}` };
}

export function readMcpTokenLabel(): McpSetting<string> {
  const label = (process.env[MCP_TOKEN_LABEL_ENV] ?? "").trim();
  if (label === "") {
    return refused(
      `${MCP_TOKEN_LABEL_ENV} is not set: set it to any value, and change it to revoke every MCP token at once`,
    );
  }
  return { ok: true, value: label };
}

export function readMcpTokenTtlDays(): McpSetting<number> {
  const raw = (process.env[MCP_TOKEN_TTL_DAYS_ENV] ?? "").trim();
  if (raw === "") return { ok: true, value: MCP_TOKEN_TTL_DAYS_DEFAULT };
  const days = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > MCP_TOKEN_TTL_DAYS_MAX) {
    return refused(`${MCP_TOKEN_TTL_DAYS_ENV} must be a whole number of days from 1 to ${MCP_TOKEN_TTL_DAYS_MAX}`);
  }
  return { ok: true, value: days };
}

export function mcpChannelStatus(): McpChannelStatus {
  // Under the hold no setting enables MCP, so the hold is the one problem named, and no address is offered.
  if (isMcpHeldByGovernance()) {
    return { state: "off", problems: [GOVERNANCE_HOLD_PROBLEM], url: null, tokenTtlDays: null };
  }
  const reading = readMcpSwitch();
  const url = readMcpUrl();
  const label = readMcpTokenLabel();
  const ttl = readMcpTokenTtlDays();
  const switchProblems =
    reading.state === "off" ? [SWITCH_OFF_PROBLEM] : reading.state === "invalid" ? [MCP_ENABLED_INVALID_MESSAGE] : [];
  const problems = [
    ...switchProblems,
    ...[url, label, ttl].flatMap((setting) => (setting.ok ? [] : [setting.problem])),
  ];
  return {
    state: reading.state === "off" ? "off" : problems.length > 0 ? "misconfigured" : "ready",
    problems,
    url: url.ok ? url.value : null,
    tokenTtlDays: ttl.ok ? ttl.value : null,
  };
}
