/**
 * A cookie jar standing in for `next/headers` in the openshift route tests: `mock.module("next/headers", () =>
 * jar.module())` in the test file (a module mock is process-wide, so each file declares its own). It records every
 * cookie read, set and delete with its options, so a test measures "no cookie was read or changed", and serves
 * `headers().get()` from a map a test fills.
 */
export interface CookieWrite {
  readonly op: "set" | "delete";
  readonly name: string;
  readonly value?: string;
  readonly options?: Record<string, unknown>;
}

export class CookieJar {
  readonly values = new Map<string, string>();
  readonly writes: CookieWrite[] = [];
  readonly reads: string[] = [];
  readonly headers = new Map<string, string>();
  /** When set, the next `set` throws this error instead of writing. */
  failNextSet: Error | null = null;

  reset(): void {
    this.values.clear();
    this.writes.length = 0;
    this.reads.length = 0;
    this.headers.clear();
    this.failNextSet = null;
  }

  /** The writes of one operation, or every write of one cookie. */
  written(name: string): CookieWrite[] {
    return this.writes.filter((write) => write.name === name);
  }

  module() {
    const store = {
      get: (name: string) => {
        this.reads.push(name);
        const value = this.values.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string, options?: Record<string, unknown>) => {
        if (this.failNextSet !== null) {
          const error = this.failNextSet;
          this.failNextSet = null;
          throw error;
        }
        this.writes.push({ op: "set", name, value, options });
        this.values.set(name, value);
      },
      delete: (cookie: string | ({ name: string } & Record<string, unknown>)) => {
        const name = typeof cookie === "string" ? cookie : cookie.name;
        this.writes.push({ op: "delete", name, options: typeof cookie === "string" ? undefined : cookie });
        this.values.delete(name);
      },
    };
    return {
      cookies: async () => store,
      headers: async () => ({ get: (name: string) => this.headers.get(name.toLowerCase()) ?? null }),
    };
  }
}
