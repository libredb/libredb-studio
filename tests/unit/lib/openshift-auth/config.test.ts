import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { AuthConfigError } from "@/lib/auth-errors";
import {
  OPENSHIFT_API_CA_FILE_ENV,
  OPENSHIFT_API_URL_ENV,
  OPENSHIFT_CALLBACK_PATH,
  OPENSHIFT_CLIENT_ID_ENV,
  OPENSHIFT_LOGIN_PATH,
  OPENSHIFT_PUBLIC_URL_ENV,
  OPENSHIFT_SCOPE,
  OPENSHIFT_TOKEN_FILE_ENV,
  OpenShiftConfigError,
  openShiftApiCaFilePath,
  openShiftApiUrl,
  openShiftCallbackUrl,
  openShiftClientId,
  openShiftPublicUrl,
  openShiftTokenFilePath,
} from "@/lib/openshift-auth/config";

const KEYS = [
  "OPENSHIFT_OAUTH_CLIENT_ID",
  "OPENSHIFT_OAUTH_TOKEN_FILE",
  "OPENSHIFT_API_URL",
  "OPENSHIFT_API_CA_FILE",
  "OPENSHIFT_PUBLIC_URL",
  "NEXT_PUBLIC_BASE_PATH",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function set(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The error a getter throws for `value`; it must name the variable and never quote the value. */
function refusal(name: string, value: string | undefined, read: () => unknown): OpenShiftConfigError {
  set(name, value);
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenShiftConfigError);
    expect(error).toBeInstanceOf(AuthConfigError);
    const message = (error as Error).message;
    expect(message).toContain(name);
    if (value !== undefined && value.trim() !== "") expect(message).not.toContain(value.trim());
    return error as OpenShiftConfigError;
  }
  throw new Error(`expected ${name}=${JSON.stringify(value)} to be refused`);
}

describe("openshift-auth config constants", () => {
  test("the variable names, scope and paths are fixed", () => {
    expect([
      OPENSHIFT_CLIENT_ID_ENV,
      OPENSHIFT_TOKEN_FILE_ENV,
      OPENSHIFT_API_URL_ENV,
      OPENSHIFT_API_CA_FILE_ENV,
      OPENSHIFT_PUBLIC_URL_ENV,
    ]).toEqual([
      "OPENSHIFT_OAUTH_CLIENT_ID",
      "OPENSHIFT_OAUTH_TOKEN_FILE",
      "OPENSHIFT_API_URL",
      "OPENSHIFT_API_CA_FILE",
      "OPENSHIFT_PUBLIC_URL",
    ]);
    expect(OPENSHIFT_SCOPE).toBe("user:info user:check-access");
    expect(OPENSHIFT_LOGIN_PATH).toBe("/api/auth/openshift/login");
    expect(OPENSHIFT_CALLBACK_PATH).toBe("/api/auth/openshift/callback");
  });
});

describe("openShiftClientId", () => {
  test("accepts Studio's ServiceAccount, trimmed", () => {
    set(OPENSHIFT_CLIENT_ID_ENV, " system:serviceaccount:os-lab-studio:studio ");
    expect(openShiftClientId()).toBe("system:serviceaccount:os-lab-studio:studio");
    set(OPENSHIFT_CLIENT_ID_ENV, `system:serviceaccount:a:${"b".repeat(253)}`);
    expect(openShiftClientId()).toBe(`system:serviceaccount:a:${"b".repeat(253)}`);
    set(OPENSHIFT_CLIENT_ID_ENV, `system:serviceaccount:${"n".repeat(63)}:${"b".repeat(253)}`);
    expect(openShiftClientId()).toBe(`system:serviceaccount:${"n".repeat(63)}:${"b".repeat(253)}`);
    set(OPENSHIFT_CLIENT_ID_ENV, "system:serviceaccount:team-a:studio.sa-1");
    expect(openShiftClientId()).toBe("system:serviceaccount:team-a:studio.sa-1");
  });

  test("refuses anything else", () => {
    for (const value of [
      undefined,
      "",
      "system:serviceaccount:OS-Lab:studio",
      "system:serviceaccount:os-lab-studio:",
      `system:serviceaccount:os-lab-studio:${"b".repeat(254)}`,
      `system:serviceaccount:${"n".repeat(63)}:${"b".repeat(254)}`,
      `system:serviceaccount:os-lab-studio:${"b".repeat(400)}-`,
      "serviceaccount:x:y",
      "system:serviceaccount:-ns:studio",
      `system:serviceaccount:${"n".repeat(64)}:studio`,
      "system:serviceaccount:ns:studio:extra",
      "system:serviceaccount:ns:Studio",
      "system:serviceaccount:ns:studio..sa",
    ]) {
      refusal(OPENSHIFT_CLIENT_ID_ENV, value, openShiftClientId);
    }
  });
});

describe("openShiftPublicUrl and openShiftCallbackUrl", () => {
  test("accepts the https origin without a base path, with or without one trailing slash", () => {
    for (const value of ["https://studio.apps.example.com", "https://studio.apps.example.com/"]) {
      set(OPENSHIFT_PUBLIC_URL_ENV, value);
      expect(openShiftPublicUrl().href).toBe("https://studio.apps.example.com/");
      expect(openShiftCallbackUrl()).toBe("https://studio.apps.example.com/api/auth/openshift/callback");
    }
  });

  test("accepts a path equal to the build's base path", () => {
    set("NEXT_PUBLIC_BASE_PATH", "/studio");
    for (const value of ["https://host/studio", "https://host/studio/"]) {
      set(OPENSHIFT_PUBLIC_URL_ENV, value);
      expect(openShiftPublicUrl().href).toBe("https://host/studio");
      expect(openShiftCallbackUrl()).toBe("https://host/studio/api/auth/openshift/callback");
    }
  });

  test("refuses an unset, relative, http, credentialed, query, fragment or other-path URL", () => {
    for (const value of [
      undefined,
      " ",
      "studio.apps.example.com",
      "http://studio.apps.example.com",
      "https://user:secret-not-real@studio.apps.example.com",
      "https://user@studio.apps.example.com",
      "https://studio.apps.example.com/?x=1",
      "https://studio.apps.example.com/?",
      "https://studio.apps.example.com/#top",
      "https://studio.apps.example.com#",
      "https://studio.apps.example.com/studio",
      "https://studio.apps.example.com//",
    ]) {
      refusal(OPENSHIFT_PUBLIC_URL_ENV, value, openShiftPublicUrl);
      refusal(OPENSHIFT_PUBLIC_URL_ENV, value, openShiftCallbackUrl);
    }
  });

  test("refuses the bare origin when the build has a base path", () => {
    set("NEXT_PUBLIC_BASE_PATH", "/studio");
    refusal(OPENSHIFT_PUBLIC_URL_ENV, "https://host", openShiftPublicUrl);
    refusal(OPENSHIFT_PUBLIC_URL_ENV, "https://host/other", openShiftPublicUrl);
  });
});

describe("openShiftApiUrl", () => {
  test("defaults to the in-cluster API server", () => {
    expect(openShiftApiUrl().href).toBe("https://kubernetes.default.svc/");
    set(OPENSHIFT_API_URL_ENV, "  ");
    expect(openShiftApiUrl().href).toBe("https://kubernetes.default.svc/");
  });

  test("drops trailing slashes and keeps a path prefix", () => {
    set(OPENSHIFT_API_URL_ENV, "https://api.crc.testing:6443///");
    expect(openShiftApiUrl().href).toBe("https://api.crc.testing:6443/");
    set(OPENSHIFT_API_URL_ENV, "https://gateway.example.com/k8s/");
    expect(openShiftApiUrl().href).toBe("https://gateway.example.com/k8s");
  });

  test("refuses a relative, http, credentialed, query or fragment URL", () => {
    for (const value of [
      "kubernetes.default.svc",
      "http://kubernetes.default.svc",
      "https://user:secret-not-real@kubernetes.default.svc",
      "https://kubernetes.default.svc/?a=b",
      "https://kubernetes.default.svc?",
      "https://kubernetes.default.svc/#x",
    ]) {
      refusal(OPENSHIFT_API_URL_ENV, value, openShiftApiUrl);
    }
  });
});

describe("openShiftTokenFilePath", () => {
  test("has no default and refuses a relative path", () => {
    for (const value of [undefined, "", "  ", "oauth-client-token", "./token"]) {
      refusal(OPENSHIFT_TOKEN_FILE_ENV, value, openShiftTokenFilePath);
    }
  });

  test("returns the absolute path, trimmed", () => {
    set(OPENSHIFT_TOKEN_FILE_ENV, " /var/run/secrets/libredb/openshift/oauth-client-token ");
    expect(openShiftTokenFilePath()).toBe("/var/run/secrets/libredb/openshift/oauth-client-token");
  });

  // Studio also runs on Windows (npx, the Windows launcher), where a temporary or program-data path starts with a drive.
  test("is absolute as path.isAbsolute answers on the platform the server runs on", () => {
    const values = [
      "/var/run/secrets/libredb/openshift/oauth-client-token",
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\libredb-openshift-auth-x\\oauth-client-token",
      "d:/libredb/oauth-client-token",
      "\\\\server\\share\\oauth-client-token",
      "\\oauth-client-token",
      "C:oauth-client-token",
      "C:",
      "1:\\oauth-client-token",
      ".\\oauth-client-token",
      "oauth-client-token",
    ];
    const answers = { win32: win32.isAbsolute, linux: posix.isAbsolute, darwin: posix.isAbsolute } as const;
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    try {
      for (const [platform, isAbsolute] of Object.entries(answers)) {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        for (const value of values) {
          set(OPENSHIFT_TOKEN_FILE_ENV, value);
          let accepted = true;
          try {
            openShiftTokenFilePath();
          } catch {
            accepted = false;
          }
          expect(accepted, `${platform}: ${value}`).toBe(isAbsolute(value));
        }
      }
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
    // The table holds both answers on each platform, so the parity above is not vacuous.
    expect(values.filter((value) => win32.isAbsolute(value))).toHaveLength(5);
    expect(values.filter((value) => posix.isAbsolute(value))).toHaveLength(1);
  });
});

describe("openShiftApiCaFilePath", () => {
  test("defaults to the ServiceAccount CA and reads a set value trimmed", () => {
    expect(openShiftApiCaFilePath()).toBe("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
    set(OPENSHIFT_API_CA_FILE_ENV, " /var/run/secrets/libredb/openshift/ca.crt ");
    expect(openShiftApiCaFilePath()).toBe("/var/run/secrets/libredb/openshift/ca.crt");
  });
});
