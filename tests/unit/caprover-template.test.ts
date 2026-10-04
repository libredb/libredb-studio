/**
 * Unit tests for the CapRover one-click template (deploy/caprover/libredb-studio.yml).
 *
 * This file is the source a submission to caprover/one-click-apps is cut from, and that
 * repository validates what it receives: scripts/validate_apps.js rejects an app whose
 * `description` runs past 200 characters, and its CI runs that validator on every pull
 * request. Nothing here measured it, so the description grew to 293 characters while the
 * engine list was kept exhaustive for the catalog-copy gate, and the bump to 0.16.1 was the
 * pull request that would have failed.
 *
 * The two rules pull in opposite directions, which is why both are asserted below: the copy
 * gate in tests/unit/lib/catalog-copy-engine-count.test.ts requires the numeral to match
 * EXTERNAL_DATABASE_TYPES and an exhaustive list to name every engine, and this limit is what
 * makes the abridged form ("and more") the only one that fits.
 *
 * Two describes, because the two sets of rules have different owners. The first is what
 * upstream's validator actually enforces, read from its source. The second is ours, and a
 * single describe claiming upstream enforced all of it was itself a false statement.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

/** The limit scripts/validate_apps.js enforces in caprover/one-click-apps. */
const DESCRIPTION_LIMIT = 200;

const TEMPLATE = path.join(__dirname, "../../deploy/caprover/libredb-studio.yml");

/** The logo upstream looks for beside the app, as public/v4/logos/<app>.png. */
const LOGO = path.join(__dirname, "../../deploy/caprover/libredb-studio.png");

/** Read once as text too: some rules below are about the submitted artifact rather than the
 *  parsed document, including the YAML comments, which no parsed read returns at all.
 *  Everything a parsed read can see is asserted against the parsed document, because that is
 *  what CapRover itself acts on. */
const RAW = fs.readFileSync(TEMPLATE, "utf8");

const template = parse(RAW) as {
  captainVersion?: number | string;
  services?: Record<string, { image?: string; environment?: Record<string, unknown> }>;
  caproverOneClickApp?: {
    description?: string;
    instructions?: { start?: string; end?: string };
    variables?: Array<{ id: string; defaultValue?: string; description?: string }>;
  };
};

/** The service CapRover deploys, read once. A rename, which CapRover would reject, reddens
 *  both the blocks test and the cookie override test, and the blocks test is the one that
 *  names the real cause. */
const service = template.services?.["$$cap_appname"];
const environment = service?.environment ?? {};
const instructionsEnd = template.caproverOneClickApp?.instructions?.end ?? "";
const versionVariable = template.caproverOneClickApp?.variables?.find((variable) => variable.id === "$$cap_version");

describe("what caprover/one-click-apps validate_apps.js enforces", () => {
  test("captainVersion is 4, the version of the directory it is submitted to", () => {
    // validate_apps.js compares String(content.captainVersion) to "4" and throws on any
    // other value. Nothing here asserted it, so a typo would have been caught only by the
    // submission PR's CI, in another repository.
    expect(String(template.captainVersion)).toBe("4");
  });

  test("the caproverOneClickApp and services blocks are both present", () => {
    expect(template.caproverOneClickApp).toBeTruthy();
    expect(template.services).toBeTruthy();
    expect(service).toBeTruthy();
  });

  test("the description is present and fits the 200-character limit", () => {
    const description = template.caproverOneClickApp?.description ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  test("both instruction blocks are present", () => {
    expect(template.caproverOneClickApp?.instructions?.start).toBeTruthy();
    expect(instructionsEnd).toBeTruthy();
  });

  test("the logo submitted beside this file exists", () => {
    // validate_apps.js throws when public/v4/logos/<app>.png is missing, so a rename here
    // breaks the submission and nothing in this repo would have said so.
    expect(fs.existsSync(LOGO)).toBe(true);
    expect(fs.statSync(LOGO).isFile()).toBe(true);
  });
});

describe("what this repository requires of the template", () => {
  test("the version variable offers a pinned tag, never latest", () => {
    expect(versionVariable?.defaultValue).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the version moves in both places at once", () => {
    // README: "The version appears twice in that file, the defaultValue of $$cap_version and
    // the example inside its description, and both must move together." Nothing checked that,
    // so an upgrade could leave the example naming the release before it.
    const pinned = versionVariable?.defaultValue ?? "";
    expect(pinned).toBeTruthy();
    expect(versionVariable?.description ?? "").toContain(`Example - ${pinned}.`);
  });

  test("the plain-HTTP cookie override is present", () => {
    // CapRover serves over http until the operator enables HTTPS, and the app marks its auth
    // cookie Secure on a non-loopback host, so the browser drops it and login loops with no
    // error. The override lived only in the published catalog for a while, which meant the
    // next sync from this folder would have removed it silently.
    //
    // Read from the parsed env block and not from the file text: commenting the line out left
    // a text match passing, so the test read green while the deployed app had no such
    // variable at all.
    expect(environment.AUTH_COOKIE_SECURE).toBe("false");
  });

  test("the login rate limiter keys on the address CapRover's nginx saw", () => {
    // CapRover's nginx is one proxy hop in front of the app. With TRUSTED_PROXY_HOPS at its
    // default of 0 the limiter keys on the leftmost X-Forwarded-For entry, which the client
    // writes, so a client could choose the bucket it lands in (docs/SECURITY.md, Known
    // limits). Read from the parsed env block, for the reason the cookie test gives.
    expect(environment.TRUSTED_PROXY_HOPS).toBe("1");
  });

  test("the instructions say what the override costs, not just its name", () => {
    // The house rule in tests/unit/marketplace-copy.test.ts, applied to every channel whose
    // provisioning writes AUTH_COOKIE_SECURE=false: naming the variable is not the
    // disclosure, the reader has to be told the cookie is not encrypted. That gate collects
    // its channels by scanning shell provisioners under deploy/, so a YAML template is
    // structurally outside its reach and this stands in. It covers DigitalOcean and AWS
    // today; Azure writes the same variable behind a condition and is exempt there by design.
    //
    // Matched on accepted SHAPES rather than on the presence of a word. A word match let
    // "The session cookie is encrypted, not cleartext, so this app is safe on any network."
    // through, which is the one sentence this test exists to stop, and at the same time it
    // rejected "in the clear", "in plain text", "anyone on the network can read it" and a
    // disclosure split over two sentences, all of which are honest.
    //
    // What it cannot do is judge meaning. It checks that a sentence in this block asserts
    // exposure in one of these shapes, that the cookie is named in it or in the sentence
    // before it, and that the assertion is not negated by the words in front of it. A
    // sentence engineered to contain a shape and mean the opposite would pass; review is
    // the backstop for that, not this test.
    const EXPOSURE = [
      /travels? in cleartext/i,
      /travels? in the clear/i,
      /travels? in plain ?text/i,
      /sent in cleartext/i,
      /sent unencrypted/i,
      /(is|are) not encrypted/i,
      /anyone on the (network|wire) can read/i,
      /can be read on the (network|wire)/i,
    ];
    /** A negator in front of the claim reverses it; one after it ("and is never protected
     *  before then") strengthens it, so only what precedes the phrase is examined. The
     *  dismissive verbs are there because "Ignore any report that the cookie travels in
     *  cleartext" carries the shape and denies it without a grammatical negation. */
    const NEGATED =
      /\b(never|not|no longer|rarely|cannot|does not|doesn't|ignore|disregard|untrue|false|myth|incorrectly)\b[^.]{0,40}?(travels? in (cleartext|the clear|plain ?text)|sent (in cleartext|unencrypted)|(is|are) not encrypted)/i;

    expect(instructionsEnd).toContain("AUTH_COOKIE_SECURE");
    const sentences = instructionsEnd.split(/(?<=[.!?])\s+/);
    const at = sentences.findIndex((sentence) => EXPOSURE.some((shape) => shape.test(sentence)));
    expect(at).toBeGreaterThanOrEqual(0);
    const cost = sentences[at];
    expect(sentences.slice(Math.max(0, at - 1), at + 1).join(" ")).toMatch(/cookie/i);
    expect(cost).not.toMatch(NEGATED);
  });

  test("the instructions say how to undo the override, and in which order", () => {
    // Deleting the remedy left every other assertion green while the commit message called
    // it the value of the change. The order matters as much as the value: in CapRover these
    // are two separate controls, a button (caprover-frontend, apps.app_active_ssl_button)
    // and a checkbox (apps.force_http_text, "Force HTTPS by redirecting all HTTP traffic to
    // HTTPS"), so turning the flag on after the first and before the second returns the same
    // silent loop to anyone arriving over http.
    expect(instructionsEnd).toMatch(/set AUTH_COOKIE_SECURE to true/i);
    expect(instructionsEnd).toContain("App Configs");
    expect(instructionsEnd).toContain("Force HTTPS");
  });

  test("the standard account is not sold as read-only", () => {
    // "query execution only" stood in four places here, and in nine files elsewhere:
    // deploy/railway (four), deploy/dokploy, deploy/cosmos, deploy/kubero, plus
    // docker-compose.example.yml and .env.example at the repo root.
    // Measured 2026-09-29 against the pinned image: a user-role session is refused 403 at
    // /api/admin/audit and /api/db/maintenance and reaches /api/db/query like the admin does.
    // The product records the same ruling in src/app/api/db/objects/edit-plan/route.ts: "the
    // role decides WHICH connection may be opened and nothing about what may be done with
    // it." An operator who reads "query only" hands those credentials to an analyst.
    // Whole file, not just instructions.end, and the claim rather than one phrasing: writing
    // "read-only access, cannot change data" into a variable description left every test
    // green while saying the same untrue thing on the install form.
    expect(RAW).not.toMatch(/query[ -]only/i);
    expect(RAW).not.toMatch(/query execution only/i);
    // "read-only" is only a defect as a CLAIM. The correction itself has to say the words
    // ("it is not a read-only account"), so occurrences denied in front are allowed and
    // every other one is not. "read-only AI" in the description is a different subject and
    // is not matched.
    const soldAsReadOnly = [...RAW.matchAll(/read-only[ -](access|account|user)/gi)].filter(
      (match) => !/\bnot an? $/i.test(RAW.slice(Math.max(0, (match.index ?? 0) - 10), match.index)),
    );
    expect(soldAsReadOnly.map((match) => match[0])).toEqual([]);
    expect(RAW).not.toMatch(/cannot (change|modify|write) (data|anything)/i);
    expect(instructionsEnd).toMatch(/not a read-only account/i);
  });

  test("the key paragraph does not offer STORAGE_ENCRYPTION_KEY as a rotation remedy", () => {
    // It used to: "To rotate JWT_SECRET safely, set a separate STORAGE_ENCRYPTION_KEY env
    // var first (App Configs tab) so the two are independent." src/lib/storage/encryption.ts
    // derives the key from that variable as soon as it exists, so introducing it IS the key
    // change the sentence above warns about, and following the remedy loses every saved
    // connection password with nothing on screen to say so. docs/STORAGE.md states it
    // correctly; this template did not.
    expect(instructionsEnd).toContain("STORAGE_ENCRYPTION_KEY");
    expect(instructionsEnd).not.toMatch(/rotate JWT_SECRET safely/i);
    expect(instructionsEnd).toMatch(/itself a key change/i);
  });

  test("the SSO paragraph does not call the OIDC variables inert", () => {
    // It used to say they "have no effect on their own" while NEXT_PUBLIC_AUTH_PROVIDER
    // stays local. Measured 2026-09-29 against the pinned image: with the provider at local
    // and OIDC_* set, GET /api/auth/oidc/login answered 307 to the provider and set the
    // oidc-state cookie. With it at oidc, POST /api/auth/login still answered 200 for the
    // admin password. The variable decides only what the sign-in page renders, so the old
    // sentence invited an operator to stage a live, unreviewed login path.
    expect(instructionsEnd).not.toMatch(/no effect on their own/i);
    expect(instructionsEnd).toMatch(/OIDC_ADMIN_ROLES/);
  });

  test("the credentials paragraph does not claim the passwords are unreadable afterwards", () => {
    // "the passwords are not shown again" contradicted the line eleven rows above it, which
    // sends the operator to the App Configs tab. The passwords are environment variables of
    // this app, so that tab is exactly where they stay readable.
    // Whole file: the same claim stood in two variable descriptions, which CapRover renders
    // on the install form, earlier than the screen they were talking about.
    expect(RAW).not.toMatch(/shown only once/i);
    expect(RAW).not.toMatch(/(passwords?|credentials) are not shown again/i);
    expect(RAW).not.toMatch(/never readable again/i);
    expect(instructionsEnd).toContain("ADMIN_PASSWORD");
  });

  test("nothing in this template carries a character we strip downstream", () => {
    // Three of the four revisions published to caprover/one-click-apps carried a rocket and
    // a warning sign; the fourth, 2026-09-22, was the first cleaned by hand. Leaving them
    // here means doing that by hand on every submission, and three times out of four nobody
    // did.
    //
    // One assertion rather than a list of code points. Naming the two dashes let U+2015,
    // U+2212, curly quotes, an ellipsis and a non-breaking space through, all of which read
    // as the same tell. The file is plain ASCII today and there is nothing it needs that is
    // not, so the whole class closes here.
    const nonAscii = [...RAW].filter((character) => character.codePointAt(0)! > 0x7f);
    expect(nonAscii).toEqual([]);
  });
});
