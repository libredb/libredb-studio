/**
 * The Kubernetes access review's switch and settings (src/lib/kubernetes-access/config.ts).
 *
 * Off unless `KUBERNETES_ACCESS_REVIEW` switches it on; a value Studio does not know counts as on, so a typo fails
 * closed and the boot preflight names it. Every other reader refuses an invalid value with an error naming its
 * variable, never quoting a value, instead of falling back to a default.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACCESS_REVIEW_ENV,
  AccessReviewConfigError,
  accessReviewAdminDeployment,
  accessReviewApiUrl,
  accessReviewCacheMs,
  accessReviewCaPath,
  accessReviewEnabled,
  accessReviewSwitch,
  accessReviewTokenPath,
} from "@/lib/kubernetes-access/config";

const ROOT = path.resolve(import.meta.dir, "../../../..");

const KEYS = [
  "KUBERNETES_ACCESS_REVIEW",
  "KUBERNETES_ACCESS_REVIEW_API_URL",
  "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH",
  "KUBERNETES_ACCESS_REVIEW_CA_PATH",
  "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
  "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The message a reader refuses the environment with. */
function refusal(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessReviewConfigError);
    return (error as Error).message;
  }
  throw new Error("expected the reader to refuse the environment");
}

describe("the switch", () => {
  test("is off while unset or empty, and its variable is KUBERNETES_ACCESS_REVIEW", () => {
    expect(ACCESS_REVIEW_ENV).toBe("KUBERNETES_ACCESS_REVIEW");
    expect(accessReviewSwitch()).toBe("off");
    expect(accessReviewEnabled()).toBe(false);
    process.env.KUBERNETES_ACCESS_REVIEW = "";
    expect(accessReviewSwitch()).toBe("off");
    process.env.KUBERNETES_ACCESS_REVIEW = "   ";
    expect(accessReviewSwitch()).toBe("off");
  });

  test.each(["off", "false", "0", " OFF ", "False"])("%p switches it off", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW = value;
    expect(accessReviewSwitch()).toBe("off");
    expect(accessReviewEnabled()).toBe(false);
  });

  test.each(["on", "true", "1", " ON ", "True"])("%p switches it on", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW = value;
    expect(accessReviewSwitch()).toBe("on");
    expect(accessReviewEnabled()).toBe(true);
  });

  test.each(["yes", "enabled", "of", "'on'"])("%p is invalid and counts as on, so a typo fails closed", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW = value;
    expect(accessReviewSwitch()).toBe("invalid");
    expect(accessReviewEnabled()).toBe(true);
  });
});

describe("the API server address", () => {
  test("defaults to the in-cluster name of the Kubernetes API", () => {
    expect(accessReviewApiUrl().href).toBe("https://kubernetes.default.svc/");
  });

  test("takes an https URL, with a port and a path, and drops a trailing slash from the path", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = " https://10.43.0.1:6443/ ";
    expect(accessReviewApiUrl().href).toBe("https://10.43.0.1:6443/");
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = "https://api.example.internal/prefix/";
    expect(accessReviewApiUrl().pathname).toBe("/prefix");
  });

  test.each([
    ["http://kubernetes.default.svc", "must use https"],
    ["not a url", "is not an absolute URL"],
    ["https://user:pass@kubernetes.default.svc", "must not carry a user name or password"],
    ["https://kubernetes.default.svc?x=1", "must not carry a query or a fragment"],
    ["https://kubernetes.default.svc#x", "must not carry a query or a fragment"],
  ])("refuses %p", (value, reason) => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = value;
    const message = refusal(accessReviewApiUrl);
    expect(message).toContain("KUBERNETES_ACCESS_REVIEW_API_URL");
    expect(message).toContain(reason);
    // A URL can carry credentials in its user info, so no refusal quotes the value.
    expect(message).not.toContain("pass@");
  });
});

describe("the token and CA files", () => {
  test("default to the ServiceAccount mount, and a blank value keeps the default", () => {
    expect(accessReviewTokenPath()).toBe("/var/run/secrets/kubernetes.io/serviceaccount/token");
    expect(accessReviewCaPath()).toBe("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
    process.env.KUBERNETES_ACCESS_REVIEW_TOKEN_PATH = "  ";
    process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH = "";
    expect(accessReviewTokenPath()).toBe("/var/run/secrets/kubernetes.io/serviceaccount/token");
    expect(accessReviewCaPath()).toBe("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
  });

  test("take the paths a projected volume mounts, trimmed", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_TOKEN_PATH = " /var/run/secrets/libredb/access-review/token ";
    process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH = "/var/run/secrets/libredb/access-review/ca.crt";
    expect(accessReviewTokenPath()).toBe("/var/run/secrets/libredb/access-review/token");
    expect(accessReviewCaPath()).toBe("/var/run/secrets/libredb/access-review/ca.crt");
  });
});

describe("the decision cache lifetime", () => {
  test("is 30 seconds by default", () => {
    expect(accessReviewCacheMs()).toBe(30_000);
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = " ";
    expect(accessReviewCacheMs()).toBe(30_000);
  });

  test.each([
    ["0", 0],
    ["15", 15_000],
    [" 60 ", 60_000],
  ])("takes %p seconds", (value, ms) => {
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = value;
    expect(accessReviewCacheMs()).toBe(ms);
  });

  test.each(["61", "-1", "1.5", "15s", "abc"])("refuses %p", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = value;
    expect(refusal(accessReviewCacheMs)).toBe(
      "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS must be a whole number of seconds from 0 to 60",
    );
  });
});

describe("the admin Deployment", () => {
  test("is required: unset or blank is refused, because no one could then be an admin", () => {
    expect(refusal(accessReviewAdminDeployment)).toContain("KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT is not set");
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "  ";
    expect(refusal(accessReviewAdminDeployment)).toContain("is not set");
  });

  test("is read as <namespace>/<name>", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = " libredb-studio/libredb-studio ";
    expect(accessReviewAdminDeployment()).toEqual({ namespace: "libredb-studio", name: "libredb-studio" });
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "tools/studio.v2";
    expect(accessReviewAdminDeployment()).toEqual({ namespace: "tools", name: "studio.v2" });
  });

  test.each([
    "libredb-studio",
    "a/b/c",
    "/libredb-studio",
    "libredb-studio/",
    "Libredb/studio",
    "ns/Studio",
    "ns_1/studio",
    `${"a".repeat(64)}/studio`,
    `ns/${"a".repeat(254)}`,
  ])("refuses %p", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = value;
    expect(refusal(accessReviewAdminDeployment)).toBe(
      "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT must name Studio's Deployment as <namespace>/<name>, such as libredb-studio/libredb-studio",
    );
  });
});

test("the module imports no Node built-in, so any server module can ask the switch", () => {
  const source = readFileSync(path.join(ROOT, "src/lib/kubernetes-access/config.ts"), "utf8");
  expect(source).not.toMatch(/from "(node:)?(fs|https|http|crypto|path|os)"/);
});
