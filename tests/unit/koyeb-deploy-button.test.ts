import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";

// The Koyeb deploy button carries the whole service definition in its URL, environment
// variables included, and that URL lives in a public README. Koyeb cannot generate a
// secret, so the button has to prefill one — and a prefilled secret that CLEARS the
// minimum is a working secret everyone can read: the app boots, signs tokens with it and
// says nothing (#943). Under the minimum, the boot check that already exists stops the
// deploy and names the reason, which is the only safe thing a published placeholder can do.

const README = readFileSync("README.md", "utf8");

/**
 * Every environment variable EVERY Koyeb button in the file sets.
 *
 * Every, twice over, and both halves were holes a previous version of this guard had. It
 * read only the FIRST matching line, so a second button lower down was unguarded; and it
 * picked the pairs apart with a regular expression over one spelling of the encoding, so
 * `env[ADMIN_PASSWORD]=` unencoded, or `%5b` in lower case, walked straight past it. Both
 * are the same URL to Koyeb. Parsing with `URL` asks the question the reader's browser
 * asks rather than the question the author happened to type.
 */
function koyebEnv(): Map<string, string> {
  const urls = README.match(/https:\/\/app\.koyeb\.com\/deploy\?[^)\s]+/g);
  if (urls === null) throw new Error("the Koyeb deploy button is no longer in README.md");
  const env = new Map<string, string>();
  for (const href of urls) {
    for (const [key, value] of new URL(href).searchParams) {
      const named = /^env\[([A-Z_]+)\]$/.exec(key);
      if (named !== null) env.set(named[1], value);
    }
  }
  return env;
}

describe("the Koyeb deploy button", () => {
  test("prefills a JWT_SECRET the server will refuse", () => {
    const secret = koyebEnv().get("JWT_SECRET");
    expect(secret).toBeDefined();
    expect(secret!.length).toBeLessThan(JWT_SECRET_MIN_LENGTH);
  });

  test("prefills no password at all", () => {
    const env = koyebEnv();
    // A placeholder password is still a password. `set_a_real_password` was the previous
    // spelling and it SIGNED IN: measured against a running container, the standard user
    // account accepted it, and a deploy where only the administrator field was replaced
    // left an account open on a credential published in this file. There is no placeholder
    // that fixes that, so the button carries neither. Unset, the two behave differently and
    // both answers are safe: `ADMIN_PASSWORD` is generated on first run and printed to the
    // log, while `USER_PASSWORD` is never generated — `getAuthUsers` adds that account only
    // when it is set, so without it there is no second account to sign into.
    for (const key of ["ADMIN_PASSWORD", "USER_PASSWORD"]) {
      expect(env.has(key)).toBe(false);
    }
  });

  test("still carries the settings the button exists to set", () => {
    const env = koyebEnv();
    expect(env.get("STORAGE_PROVIDER")).toBe("local");
    expect(env.get("ADMIN_EMAIL")).toBe("admin@libredb.org");
  });
});
