/**
 * Unit tests for the CapRover one-click templates (deploy/caprover/libredb-studio.yml and
 * deploy/caprover/libredb-studio-autoconnect.yml).
 *
 * These files are the source a submission to caprover/one-click-apps is cut from, and that
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
 * Two describes run over every template, because the two sets of rules have different
 * owners. The first is what upstream's validator actually enforces, read from its source.
 * The second is ours, and a single describe claiming upstream enforced all of it was itself
 * a false statement. A third describe holds what only the auto-connect variant carries: the
 * Docker socket, the companion app that is the only thing allowed to mount it, and the
 * README steps that rebuild that companion by hand.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

/** The limit scripts/validate_apps.js enforces in caprover/one-click-apps. */
const DESCRIPTION_LIMIT = 200;

const CAPROVER_DIR = path.join(__dirname, "../../deploy/caprover");

interface TemplateService {
  depends_on?: string[];
  image?: string;
  command?: unknown;
  environment?: Record<string, unknown>;
  volumes?: string[];
  caproverExtra?: Record<string, unknown>;
}

interface TemplateVariable {
  id: string;
  label?: string;
  defaultValue?: string;
  description?: string;
  validRegex?: string;
}

interface Template {
  captainVersion?: number | string;
  services?: Record<string, TemplateService>;
  caproverOneClickApp?: {
    displayName?: string;
    description?: string;
    instructions?: { start?: string; end?: string };
    variables?: TemplateVariable[];
  };
}

/** Every template this folder submits, found by listing the folder so that a template added
 *  later is held to every rule below without anyone remembering to add it to a list. Each is
 *  submitted with the logo upstream looks for beside it, as public/v4/logos/<app>.png. A
 *  mutable array: bun's describe.each takes a readonly table only when its rows are tuples. */
const TEMPLATES: { name: string; file: string; logo: string }[] = fs
  .readdirSync(CAPROVER_DIR)
  .filter((file) => file.endsWith(".yml"))
  .sort()
  .map((file) => {
    const name = path.basename(file, ".yml");
    return { name, file, logo: `${name}.png` };
  });

/** The one service that may bind a host path, and the one template it is in: the discovery
 *  companion, which reads the Docker socket. Named by both, so a copy of it in another
 *  template is not waved through. */
const AUTOCONNECT_FILE = "libredb-studio-autoconnect.yml";
const COMPANION = "$$cap_appname-discovery";

/** Read as text too: some rules below are about the submitted artifact rather than the
 *  parsed document, including the YAML comments, which no parsed read returns at all.
 *  Everything a parsed read can see is asserted against the parsed document, because that is
 *  what CapRover itself acts on.
 *
 *  The service CapRover deploys is read once. A rename, which CapRover would reject, reddens
 *  both the blocks test and the cookie override test, and the blocks test is the one that
 *  names the real cause. */
function loadTemplate(file: string) {
  const raw = fs.readFileSync(path.join(CAPROVER_DIR, file), "utf8");
  const template = parse(raw) as Template;
  const service = template.services?.["$$cap_appname"];
  return {
    raw,
    template,
    service,
    environment: service?.environment ?? {},
    instructionsStart: template.caproverOneClickApp?.instructions?.start ?? "",
    instructionsEnd: template.caproverOneClickApp?.instructions?.end ?? "",
    variables: template.caproverOneClickApp?.variables ?? [],
    versionVariable: template.caproverOneClickApp?.variables?.find((variable) => variable.id === "$$cap_version"),
  };
}

/** What CapRover turns into a bind mount of a host path: a volume whose source, the part before
 *  the first ":", starts with "/" (OneClickAppDeploymentHelper.createConfigurationPromise in
 *  caprover/caprover). Every other volume becomes a named volume. */
function hostBinds(service?: TemplateService): string[] {
  return (service?.volumes ?? []).filter((volume) => volume.startsWith("/"));
}

/** The longest name CapRover creates an app or a project under: isNameAllowed requires
 *  name.length < 50 in src/datastore/AppsDataStore.ts of caprover/caprover, and so does the one in
 *  src/datastore/ProjectsDataStore.ts for the project an install of more than one service creates
 *  first. */
const CAPROVER_NAME_MAX = 49;

/** The order CapRover creates a template's apps in, read the way
 *  OneClickAppDeployManager.createAppsArrayInOrder in caprover/caprover reads it: pass after pass
 *  over the services as the file lists them, taking each one whose depends_on entries, read by
 *  index, are all taken already, a service taken earlier in the same pass included. When they
 *  cannot all be taken CapRover refuses the template ("Dependency tree cannot be resolved"), and
 *  this returns undefined. Each app is registered, configured and deployed before the next one is
 *  registered, and nothing is removed when a step fails. */
function registrationOrder(services: Record<string, TemplateService>): string[] | undefined {
  const names = Object.keys(services);
  const order: string[] = [];
  for (let pass = 0; order.length < names.length && pass <= names.length; pass++) {
    for (const name of names) {
      const dependsOn = services[name].depends_on ?? [];
      let ready = !order.includes(name);
      for (let index = 0; ready && index < dependsOn.length; index++) {
        ready = order.includes(dependsOn[index]);
      }
      if (ready) order.push(name);
    }
  }
  return order.length === names.length ? order : undefined;
}

/** The longest app name every service of a template can be created under, each service being
 *  named by CapRover's plain substitution of that name for $$cap_appname. */
function longestAppName(services: Record<string, TemplateService>): number {
  const fits = (length: number) =>
    Object.keys(services).every(
      (name) => name.split("$$cap_appname").join("a".repeat(length)).length <= CAPROVER_NAME_MAX,
    );
  let length = 0;
  while (length < CAPROVER_NAME_MAX && fits(length + 1)) length++;
  return length;
}

describe.each(TEMPLATES)("$name: what caprover/one-click-apps validate_apps.js enforces", ({ file, logo }) => {
  const { template, service, instructionsEnd } = loadTemplate(file);
  const LOGO = path.join(CAPROVER_DIR, logo);

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

describe.each(TEMPLATES)("$name: what this repository requires of the template", ({ file }) => {
  const { raw: RAW, template, environment, instructionsEnd, versionVariable } = loadTemplate(file);

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

  test("the pinned version is patched for GHSA-8gc9-2gm6-5c7f", () => {
    // The install text explains how to turn on OIDC sign-in, and up to 0.17.0 a deployment with
    // OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET set accepted the OIDC state cookie,
    // which any visitor can request, as a session. 0.18.0 is the first patched release.
    const [major, minor] = (versionVariable?.defaultValue ?? "0.0.0").split(".").map(Number);
    expect(major > 0 || minor >= 18).toBe(true);
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

  test("no service binds a host path, except the discovery companion's Docker socket", () => {
    // CapRover turns a volume whose source starts with "/" into a bind mount of that host
    // path, so this reads the source and never the socket's file name: "/var/run:/var/run"
    // puts the socket in the container just as well, and a name check let it through. The one
    // exception is named by template and by service, so a copy of the companion in another
    // template is not waved through, and what the exception may bind is pinned in the
    // auto-connect describe below.
    const binds = Object.entries(template.services ?? {})
      .filter(([name]) => file !== AUTOCONNECT_FILE || name !== COMPANION)
      .flatMap(([name, service]) => hostBinds(service).map((volume) => `${name}: ${volume}`));
    expect(binds).toEqual([]);
  });
});

describe("what only the auto-connect variant carries", () => {
  const {
    raw: RAW,
    template,
    service,
    environment,
    instructionsStart,
    instructionsEnd,
    variables,
    versionVariable,
  } = loadTemplate(AUTOCONNECT_FILE);
  const plain = loadTemplate("libredb-studio.yml");
  const companion = template.services?.[COMPANION];
  const companionEnvironment = companion?.environment ?? {};
  const skipApps = variables.find((variable) => variable.id === "$$cap_skip_apps");

  const SOCKET = "/var/run/docker.sock:/var/run/docker.sock";
  const SHARED_VOLUME = "$$cap_appname-discovered:/app/discovery";

  /** The paragraph instructions.start must open with, word for word (whitespace collapsed,
   *  because the block is wrapped by hand). It is the disclosure a reader sees before the
   *  install form, so a softer rewording is a change to what the operator agreed to. */
  const DISCLOSURE =
    "This variant adds a second app, named after this one with -discovery appended, that reads the settings of the other apps on this server through the Docker socket so Studio can connect to your databases without you typing their passwords. Access to the Docker socket is equivalent to root access on this server. The discovery app has no port and is not exposed to the internet. It records the name and image of every app on this server and the database password settings of your database apps, in a file that only the Studio app and its admin login can read. Connected databases are listed for the Studio admin login only, and the standard login cannot read that file through a DuckDB connection. Still give the standard login only to someone you trust, because a connection that names a database file on this server is not limited to a directory (https://github.com/libredb/libredb-studio/blob/main/docs/providers/duckdb.md#143-the-file-path-is-a-trust-boundary-for-every-role-and-statement-reach-is-the-admins). Enable HTTPS for Studio before you sign in for the first time. If you do not want the Docker socket on this server, install the plain LibreDB Studio entry instead.";

  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const paragraphs = (text: string) => text.split(/\n\s*\n/);
  const README = fs.readFileSync(path.join(CAPROVER_DIR, "README.md"), "utf8");
  /** One README section, from its heading to the next heading of level two or three, so a
   *  sentence moved to another section no longer counts. */
  const readmeSection = (heading: string) => {
    expect(README).toContain(heading);
    return flat(README.slice(README.indexOf(heading) + heading.length).split(/^#{2,3} /m)[0]);
  };

  test("it deploys exactly two services, Studio and its discovery companion", () => {
    expect(Object.keys(template.services ?? {}).sort()).toEqual(["$$cap_appname", "$$cap_appname-discovery"]);
    expect(template.caproverOneClickApp?.displayName).toBe("LibreDB Studio (auto-connect)");
  });

  test("registrationOrder follows depends_on over the key order, and refuses what CapRover refuses", () => {
    // The order test below trusts this helper, and Studio is also the first key, so the
    // template alone would not notice a helper that ignores depends_on.
    expect(registrationOrder({ b: { depends_on: ["a"] }, a: {} })).toEqual(["a", "b"]);
    expect(registrationOrder({ a: { depends_on: ["b"] }, b: { depends_on: ["a"] } })).toBeUndefined();
    expect(registrationOrder({ a: { depends_on: ["missing"] } })).toBeUndefined();
  });

  test("CapRover creates Studio first and the socket app last, so an install that stops early never leaves the socket app on its own", () => {
    // CapRover creates the apps one at a time and removes nothing when a step fails
    // (OneClickAppDeployManager.startDeployProcess in caprover/caprover). Measured on CapRover
    // 1.15.4 with Studio naming the companion in depends_on, so that the companion was created
    // first, and an app name already in use: the install failed at Studio and left the companion
    // running with the Docker socket. With Studio first it left only the empty project. The
    // companion names Studio in depends_on, so the order does not rest on the order of the keys.
    expect(registrationOrder(template.services ?? {})).toEqual(["$$cap_appname", COMPANION]);
    expect(companion?.depends_on).toEqual(["$$cap_appname"]);
    expect(readmeSection("## Auto-connect variant")).toContain(
      "For the same reason the template has CapRover create the Studio app first, so an install that stops early never leaves the app that holds the Docker socket running on its own.",
    );
  });

  test("instructions.start and the README give the longest app name the install accepts, and what a longer one leaves", () => {
    // CapRover's App Name field checks the characters and not the length (caprover-frontend,
    // OneClickAppConfigPage.tsx), and the install first creates a project of the same name,
    // whose rule also wants a leading letter (ProjectsDataStore.ts). The numbers come from the
    // template and the CapRover limit, so a longer service name cannot leave a stale one in
    // these texts.
    const limit = longestAppName(template.services ?? {});
    expect(flat(instructionsStart)).toContain(
      `- App name: at most ${limit} characters, starting with a letter. The second app is named after it with -discovery appended, and the project CapRover puts both apps in takes the same name.`,
    );
    const variant = readmeSection("## Auto-connect variant");
    expect(variant).toContain(
      `Pick an app name of at most ${limit} characters that starts with a letter: the second app is named \`<app>-discovery\`, CapRover refuses an app name of ${CAPROVER_NAME_MAX + 1} characters or more,`,
    );
    expect(variant).toContain(
      `A name of ${limit + 1} to ${CAPROVER_NAME_MAX} characters therefore stops the install at \`<app>-discovery\` with "App Name is not allowed" and leaves the project and a Studio app without discovery; delete both before you install again under a shorter name.`,
    );
    expect(readmeSection("### Adding discovery to an existing install")).toContain(
      `If \`studio-discovery\` would have ${CAPROVER_NAME_MAX + 1} characters or more, any shorter name works: nothing reads this app's name.`,
    );
  });

  test("both services run the same Studio image and version", () => {
    expect(service?.image).toBe("ghcr.io/libredb/libredb-studio:$$cap_version");
    expect(companion?.image).toBe(service?.image);
  });

  test("the pinned version is a release that ships the exporter", () => {
    // docker/discover.mjs and SEED_DISCOVERY_PATH first ship in 0.18.0. An older tag deploys
    // a companion whose command names a file the image does not have.
    const [major, minor] = (versionVariable?.defaultValue ?? "0.0.0").split(".").map(Number);
    expect(major > 0 || minor >= 18).toBe(true);
  });

  test("the companion runs the exporter through command, which replaces the image entrypoint", () => {
    // Measured on CapRover 1.15.4: a one-click command becomes ContainerSpec.Command, which
    // replaces the ENTRYPOINT, so the process runs as uid 0 and the gosu drop in
    // docker-entrypoint.sh never happens. Opening the socket needs root.
    expect(companion?.command).toEqual(["node", "/usr/local/lib/libredb-studio/discover.mjs"]);
  });

  test("the companion's host binds are exactly the Docker socket, and the plain entry stays one service", () => {
    // Every other service in every template is kept off the host filesystem by the shared
    // describe above. The whole list is pinned here and not just "contains the socket": a
    // second bind next to it, "/" or "/var/run", would be the same access.
    expect(hostBinds(companion)).toEqual([SOCKET]);
    expect(Object.keys(plain.template.services ?? {})).toEqual(["$$cap_appname"]);
  });

  test("the companion carries only the keys it was reviewed with", () => {
    // It runs as root next to the Docker socket, so every key on it is a privilege. CapRover
    // turns cap_add into CapabilityAdd (DockerComposeToServiceOverride.parseCapAdd) and ports
    // into published ports (OneClickAppDeploymentHelper.createConfigurationPromise), and none
    // of the checks around this one looks at what else the companion has. Listed by key, so a
    // new one fails here and has to be argued for. depends_on is not a privilege: it only orders
    // the install (OneClickAppDeployManager.createAppsArrayInOrder), and createConfigurationPromise
    // keeps nothing of it on the app.
    const allowed = ["depends_on", "image", "restart", "command", "environment", "volumes", "caproverExtra"];
    expect(Object.keys(companion ?? {}).filter((key) => !allowed.includes(key))).toEqual([]);
  });

  test("the companion's environment is the three settings the exporter is given", () => {
    // Exactly these names. Anything else is a value handed to a root process, and a copy of
    // one of Studio's own (ADMIN_PASSWORD, JWT_SECRET) would be a secret handed to it.
    expect(Object.keys(companionEnvironment).sort()).toEqual([
      "DISCOVERY_EXCLUDE",
      "DISCOVERY_NETWORK",
      "DISCOVERY_OUTPUT",
    ]);
  });

  test("the companion has no port and is not exposed as a web app", () => {
    expect(companion?.caproverExtra?.notExposeAsWebApp).toBe("true");
    expect(companion?.caproverExtra?.containerHttpPort).toBeUndefined();
  });

  test("Studio reads the file the companion writes, on the volume both mount", () => {
    expect(service?.volumes).toContain(SHARED_VOLUME);
    expect(companion?.volumes).toContain(SHARED_VOLUME);
    expect(environment.SEED_DISCOVERY_PATH).toBe("/app/discovery/services.json");
    expect(companionEnvironment.DISCOVERY_OUTPUT).toBe(environment.SEED_DISCOVERY_PATH);
    expect(companionEnvironment.DISCOVERY_NETWORK).toBe("captain-overlay-network");
  });

  test("the shared volume stays out of the directory the entrypoint chowns", () => {
    // docker-entrypoint.sh chowns the directory of STORAGE_SQLITE_PATH to uid 1001 when it
    // starts as root. A shared volume under it would be writable by the web process, which
    // could then plant a symlink for the root exporter to follow; the exporter refuses to
    // start on such a directory, so discovery would never run.
    const dataDirectory = path.posix.dirname(String(environment.STORAGE_SQLITE_PATH));
    expect(dataDirectory).toBe("/app/data");
    expect(path.posix.dirname(String(environment.SEED_DISCOVERY_PATH))).toBe("/app/discovery");
    expect(String(environment.SEED_DISCOVERY_PATH).startsWith(`${dataDirectory}/`)).toBe(false);
  });

  test("the export is re-read every five seconds and the built-in samples are off", () => {
    expect(environment.SEED_CACHE_TTL_MS).toBe("5000");
    expect(environment.LIBREDB_EMBEDDED_SAMPLE).toBe("false");
    expect(environment.SQLITE_EMBEDDED_SAMPLE).toBe("false");
  });

  test("the variables are the plain template's, plus the apps-to-skip field", () => {
    const ids = (list: TemplateVariable[]) => list.map((variable) => variable.id);
    expect(ids(variables).filter((id) => id !== "$$cap_skip_apps")).toEqual(ids(plain.variables));
    expect(skipApps?.label).toBe("Apps to skip (optional)");
    expect(skipApps?.defaultValue).toBe("");
    expect(companionEnvironment.DISCOVERY_EXCLUDE).toBe("$$cap_skip_apps");
  });

  test("the apps-to-skip field admits only app names separated by commas", () => {
    // caprover-frontend reads validRegex as /<source>/<flags> and tests the typed value with
    // it (OneClickVariablesSection.tsx, isFieldValueValid). The value is then substituted
    // into the deploy JSON with no escaping, so a quote or a backslash must never pass.
    const parts = /\/(.*)\/(.*)/.exec(skipApps?.validRegex ?? "");
    expect(parts).not.toBeNull();
    const valid = new RegExp(parts?.[1] ?? "", parts?.[2]);
    for (const accepted of ["", "wordpress-db", "wordpress-db,umami-postgres"]) {
      expect(valid.test(accepted)).toBe(true);
    }
    for (const refused of ["wordpress-db, umami-postgres", "a,", ",a", "Wordpress", 'a"b', "a\\b", "a b"]) {
      expect(valid.test(refused)).toBe(false);
    }
  });

  test("instructions.start opens with the socket disclosure, before anything else", () => {
    expect(flat(instructionsStart).startsWith(DISCLOSURE)).toBe(true);
  });

  test("the description names the Docker socket, and the file publishes no engine count", () => {
    // The copy gate in tests/unit/lib/catalog-copy-engine-count.test.ts reads this file too.
    // A count here would go stale with the next engine, and this entry connects a few
    // families, not the product's whole set.
    const description = template.caproverOneClickApp?.description ?? "";
    expect(description).toContain("Docker socket");
    expect(RAW).not.toMatch(/\bengines\b/i);
  });

  test("instructions.end carries the plain template's sign-in, credentials and cookie text word for word", () => {
    // Every paragraph of the plain closing text except the first two (deployed, open at) is
    // what an operator of either entry has to know: the cookie cost and its undo order, the
    // two logins, what the standard account can do, where the passwords stay readable, the
    // volume, the key and the SSO caveats. A rewording in one file only would let the two
    // entries drift apart, and the shared describes above would not notice, because each
    // checks its own file against a shape rather than against the other file.
    const carried = paragraphs(plain.instructionsEnd).slice(2);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.some((paragraph) => paragraph.includes("AUTH_COOKIE_SECURE"))).toBe(true);
    expect(carried.some((paragraph) => paragraph.includes("$$cap_admin_password"))).toBe(true);
    const own = paragraphs(instructionsEnd);
    const missing = carried.filter((paragraph) => !own.includes(paragraph));
    expect(missing).toEqual([]);
  });

  test("instructions.end says when the databases appear, how to stop discovery and where both apps run", () => {
    const end = flat(instructionsEnd);
    expect(end).toContain(
      "Your CapRover databases appear in Studio for the admin login within about 30 seconds, and databases you add or remove later follow on their own.",
    );
    expect(end).toContain(
      "To stop discovery, delete the $$cap_appname-discovery app. Studio then withdraws the discovered connections within about two minutes.",
    );
    expect(end).toContain(
      "Both apps must run on the same node, and that node must be a swarm manager. On a single-server CapRover this is always the case. On a cluster, pin both apps to the manager in their App Configs.",
    );
  });

  test("instructions.end says the standard login cannot read the discovery file on this variant", () => {
    // The disclosure that opens instructions.start says it too, but this is the screen that hands out the
    // standard login's password.
    expect(flat(instructionsEnd)).toContain(
      "On this variant the standard login cannot read the passwords of the databases Studio found: a non-admin DuckDB connection cannot read the discovery file. The admin login can, so treat it as holding every database's password. Still give the standard login only to someone you trust, because a connection that names a database file on this server is not limited to a directory: https://github.com/libredb/libredb-studio/blob/main/docs/providers/duckdb.md#143-the-file-path-is-a-trust-boundary-for-every-role-and-statement-reach-is-the-admins",
    );
  });

  test("the README's manual steps use the template's own command, settings, network and volume label", () => {
    // "Adding discovery to an existing install" has the reader rebuild the companion by hand in
    // the dashboard, and no other test reads that text, so a rename in the template would leave
    // the steps telling the reader to type something that no longer exists. The values come
    // from the parsed template, never from a second list; what is written out here is only the
    // section's heading, which Studio settings step 1 names, and the stand-in app name the
    // README itself uses. Only that section is searched, because the description of the variant
    // above it repeats some of the same words, and it is searched by whole tokens, because a
    // substring match finds "captain-overlay" inside a stale "captain-overlay-network".
    const heading = "### Adding discovery to an existing install";
    const readme = fs.readFileSync(path.join(CAPROVER_DIR, "README.md"), "utf8");
    expect(readme).toContain(heading);
    const steps = readme.slice(readme.indexOf(heading)).split(/^## /m)[0];
    const tokens = new Set(steps.split(/[\s`'",;()[\]]+/));

    // The settings step 1 has the reader add to Studio, with the values the template gives
    // them. A value that is a template variable (the apps to skip) is typed by the reader, so
    // only its name is repeated.
    const studioSettings = ["SEED_DISCOVERY_PATH", "SEED_CACHE_TTL_MS", "TRUSTED_PROXY_HOPS"];
    const setting = (name: string, value: unknown) => (String(value).startsWith("$$cap_") ? name : `${name}=${value}`);
    // The volume both apps mount: the steps have the reader give it the same label in each.
    const sharedVolume = (service?.volumes ?? []).find((volume) => companion?.volumes?.includes(volume))!;
    const literals = [
      ...[companion?.command].flat().map(String),
      ...studioSettings.map((name) => setting(name, environment[name])),
      ...Object.entries(companionEnvironment).map(([name, value]) => setting(name, value)),
      sharedVolume.split(":")[0].replace("$$cap_appname", "studio"),
    ];
    expect(literals.filter((literal) => !tokens.has(literal))).toEqual([]);
  });
});
