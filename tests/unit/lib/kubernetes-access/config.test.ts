/**
 * The Kubernetes access review's switch and settings (src/lib/kubernetes-access/config.ts).
 *
 * Off unless `KUBERNETES_ACCESS_REVIEW` switches it on; a value Studio does not know counts as on, so a typo fails
 * closed and the boot preflight names it. In openshift sign-in mode, and under an unknown sign-in mode, it is on
 * whatever the switch says. Every other reader refuses an invalid value with an error naming its variable, never
 * quoting a value, instead of falling back to a default.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACCESS_REVIEW_ENV,
  AccessReviewConfigError,
  accessReviewAdminTarget,
  accessReviewApiUrl,
  accessReviewCacheMs,
  accessReviewCaPath,
  accessReviewEnabled,
  accessReviewSignIn,
  accessReviewSwitch,
  accessReviewTokenPath,
  OPENSHIFT_REVIEW_CACHE_SECONDS,
} from "@/lib/kubernetes-access/config";

const ROOT = path.resolve(import.meta.dir, "../../../..");

const KEYS = [
  "KUBERNETES_ACCESS_REVIEW",
  "KUBERNETES_ACCESS_REVIEW_API_URL",
  "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH",
  "KUBERNETES_ACCESS_REVIEW_CA_PATH",
  "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
  "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
  "KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO",
  "KUBERNETES_ACCESS_REVIEW_SIGN_IN",
  "NEXT_PUBLIC_AUTH_PROVIDER",
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

  test.each([
    [undefined, "off"],
    ["", "off"],
    ["off", "off"],
    ["false", "off"],
    ["on", "on"],
    ["garbage", "invalid"],
  ] as const)("is on in openshift sign-in mode whatever it says, here %p, and reads as written", (value, written) => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
    if (value !== undefined) process.env.KUBERNETES_ACCESS_REVIEW = value;
    expect(accessReviewEnabled()).toBe(true);
    expect(accessReviewSwitch()).toBe(written);
  });

  test("is on under a sign-in mode Studio does not know, which counts as openshift, and stays off in local and oidc", () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "ldap";
    expect(accessReviewEnabled()).toBe(true);
    for (const mode of ["local", "oidc", ""]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      expect(accessReviewEnabled(), mode).toBe(false);
    }
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

  test("drops every trailing slash, and keeps the ones inside the path", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = "https://api.example.internal/a//prefix///";
    expect(accessReviewApiUrl().pathname).toBe("/a//prefix");
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = "https://api.example.internal//";
    expect(accessReviewApiUrl().pathname).toBe("/");
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
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    expect(accessReviewCacheMs()).toBe(30_000);
  });

  test("is 15 seconds by default in openshift sign-in mode and under an unknown mode, and takes the same values", () => {
    expect(OPENSHIFT_REVIEW_CACHE_SECONDS).toBe(15);
    for (const mode of ["openshift", "ldap"]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      delete process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS;
      expect(accessReviewCacheMs()).toBe(15_000);
      process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "0";
      expect(accessReviewCacheMs()).toBe(0);
      process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "60";
      expect(accessReviewCacheMs()).toBe(60_000);
      process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "61";
      expect(refusal(accessReviewCacheMs)).toBe(
        "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS must be a whole number of seconds from 0 to 60",
      );
    }
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

describe("the admin target", () => {
  const BOTH_UNSET =
    "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT and KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO are both unset: with the access review on, a Studio admin is whoever may update Studio's Deployment or its LibreDBStudio resource, so name one of them as <namespace>/<name>";
  const BOTH_SET =
    "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT and KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO are both set: name Studio's Deployment for a Helm install or its LibreDBStudio resource for an operator install, not both";
  const DEPLOYMENT_INVALID =
    "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT must name Studio's Deployment as <namespace>/<name>, such as libredb-studio/libredb-studio";
  const LIBREDBSTUDIO_INVALID =
    "KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO must name Studio's LibreDBStudio resource as <namespace>/<name>, such as libredb-studio/libredb-studio";

  test("is required: with neither set, or both blank, it is refused, because no one could then be an admin", () => {
    expect(refusal(accessReviewAdminTarget)).toBe(BOTH_UNSET);
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "  ";
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "";
    expect(refusal(accessReviewAdminTarget)).toBe(BOTH_UNSET);
  });

  test("is update on Studio's Deployment, read as <namespace>/<name>", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = " libredb-studio/libredb-studio ";
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = " ";
    expect(accessReviewAdminTarget()).toEqual({
      verb: "update",
      group: "apps",
      resource: "deployments",
      namespace: "libredb-studio",
      name: "libredb-studio",
    });
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "tools/studio.v2";
    expect(accessReviewAdminTarget()).toMatchObject({ namespace: "tools", name: "studio.v2" });
  });

  test("is update on Studio's LibreDBStudio resource, read as <namespace>/<name>", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = " team-tools/studio.v2 ";
    expect(accessReviewAdminTarget()).toEqual({
      verb: "update",
      group: "studio.libredb.org",
      resource: "libredbstudios",
      namespace: "team-tools",
      name: "studio.v2",
    });
  });

  test("names one of the two, never both", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "libredb-studio/libredb-studio";
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "libredb-studio/libredb-studio";
    expect(refusal(accessReviewAdminTarget)).toBe(BOTH_SET);
  });

  const INVALID = [
    "libredb-studio",
    "a/b/c",
    "/libredb-studio",
    "libredb-studio/",
    "Libredb/studio",
    "ns/Studio",
    "ns_1/studio",
    `${"a".repeat(64)}/studio`,
    `ns/${"a".repeat(254)}`,
  ];

  test.each(INVALID)("refuses the Deployment %p", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = value;
    expect(refusal(accessReviewAdminTarget)).toBe(DEPLOYMENT_INVALID);
  });

  test.each(INVALID)("refuses the LibreDBStudio resource %p", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = value;
    expect(refusal(accessReviewAdminTarget)).toBe(LIBREDBSTUDIO_INVALID);
  });

  test("applies in every sign-in mode", () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "libredb-studio/libredb-studio";
    for (const mode of ["oidc", "openshift", "local"]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      expect(accessReviewAdminTarget().resource, mode).toBe("libredbstudios");
    }
  });
});

describe("the sign-in review", () => {
  test("defaults to list on Rancher's NavLinks at cluster scope, which a cluster member may and a user without a role may not", () => {
    expect(accessReviewSignIn()).toEqual({
      verb: "list",
      group: "ui.cattle.io",
      resource: "navlinks",
      namespace: "",
      name: "",
    });
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "  ";
    expect(accessReviewSignIn()).toEqual({
      verb: "list",
      group: "ui.cattle.io",
      resource: "navlinks",
      namespace: "",
      name: "",
    });
  });

  test.each([
    [
      "get services/libredb-studio -n libredb-studio",
      { verb: "get", group: "", resource: "services", namespace: "libredb-studio", name: "libredb-studio" },
    ],
    [
      " get  deployments.apps/libredb-studio  -n  tools ",
      { verb: "get", group: "apps", resource: "deployments", namespace: "tools", name: "libredb-studio" },
    ],
    ["list namespaces", { verb: "list", group: "", resource: "namespaces", namespace: "", name: "" }],
    ["list pods -n team-a", { verb: "list", group: "", resource: "pods", namespace: "team-a", name: "" }],
    [
      "* clusters.postgresql.cnpg.io",
      { verb: "*", group: "postgresql.cnpg.io", resource: "clusters", namespace: "", name: "" },
    ],
  ])("reads %p as kubectl auth can-i does", (value, attributes) => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = value;
    expect(accessReviewSignIn()).toEqual(attributes);
  });

  test.each([
    "list",
    "list navlinks.ui.cattle.io extra",
    "List navlinks",
    "list Navlinks",
    "list navlinks -n",
    "list navlinks -n Team-A",
    "list navlinks --namespace team-a",
    "list services/",
    "list .apps",
    "list navlinks..ui",
  ])("refuses %p", (value) => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = value;
    expect(refusal(accessReviewSignIn)).toBe(
      "KUBERNETES_ACCESS_REVIEW_SIGN_IN must be a review as kubectl auth can-i takes it, <verb> <resource>[.<group>][/<name>] [-n <namespace>], such as list navlinks.ui.cattle.io",
    );
  });
});

describe("the sign-in review in openshift sign-in mode", () => {
  test("is none while KUBERNETES_ACCESS_REVIEW_SIGN_IN is unset or blank, also under an unknown mode", () => {
    for (const mode of ["openshift", "ldap"]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      delete process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN;
      expect(accessReviewSignIn()).toBeNull();
      process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "  ";
      expect(accessReviewSignIn()).toBeNull();
    }
  });

  test("is the review KUBERNETES_ACCESS_REVIEW_SIGN_IN names when it is set, and refuses an invalid one", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/libredb-studio -n libredb-studio";
    expect(accessReviewSignIn()).toEqual({
      verb: "get",
      group: "",
      resource: "services",
      namespace: "libredb-studio",
      name: "libredb-studio",
    });
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "list";
    expect(refusal(accessReviewSignIn)).toContain("KUBERNETES_ACCESS_REVIEW_SIGN_IN must be a review");
  });

  test("keeps the Rancher default in oidc mode", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    expect(accessReviewSignIn()).toMatchObject({ verb: "list", group: "ui.cattle.io", resource: "navlinks" });
  });
});

test("the module imports no Node built-in, so any server module can ask the switch", () => {
  const source = readFileSync(path.join(ROOT, "src/lib/kubernetes-access/config.ts"), "utf8");
  expect(source).not.toMatch(/from "(node:)?(fs|https|http|crypto|path|os)"/);
});
