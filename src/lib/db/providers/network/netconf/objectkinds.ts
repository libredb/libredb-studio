import type { KeyScanCapability, ObjectKindSpec } from "@/lib/db/types";

/**
 * Who enumerates what, for the `netconf` provider, phase 1 (issue #1724), requirement Y-S6.
 *
 * This provider lists two different things from two different surfaces, and the declaration is
 * what keeps them apart:
 *
 *   a top level container or list of the selected module   the object surface enumerates it, so
 *                                                          `enumeratedBy` is ABSENT and the tree
 *                                                          draws a folder for it
 *   anything BELOW such an object                          the Keys panel enumerates it, one level
 *                                                          per page, so the kind declares
 *                                                          `enumeratedBy: "key-browser"`
 *
 * The declaration is a requirement rather than a detail because getting it wrong compiles and
 * passes every unit test. SOURCE at `90881379`: `enumerableKinds()` in
 * `src/lib/db/object-kinds.ts:61` answers the declared kinds whose `enumeratedBy` is absent, and
 * those are the kinds the tree, the inventory and search routes and the agent's grounding walk all
 * read; `keyBrowserKind()` at line 168 answers the one kind that declares `"key-browser"`. A kind
 * the Keys panel lists while leaving the field absent is therefore walked by the object surface as
 * well, and a provider that leaves it out of `countObjects` and refuses it by name in `listObjects`
 * fails that walk after the connection opens.
 *
 * SOURCE: the two existing cases declare the same three fields together,
 * `providers/keyvalue/etcd/objects.ts:138-141` and `providers/document/firestore/objects.ts:138-141`.
 * etcd adds `acceptsSourceEdits: true`; this provider does not, because it writes nothing.
 * SOURCE: `tests/isolated/object-source-declarations.test.ts` refuses a second key-browser kind,
 * one without `hasSource`, and one on capabilities that carry no `keyScan`.
 *
 * This provider is the first in the repository to declare both container levels and Keys panel
 * levels, so no existing declaration can be copied whole: the three fields below come from etcd and
 * firestore, and the container levels come from this engine.
 *
 * The shapes here are declared locally and deliberately narrow, because this directory imports
 * nothing from the repository (see README). They mirror the fields of `ObjectKindSpec` and
 * `KeyScanCapability` that this provider sets, and no more.
 */

export const NETCONF_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "node",
    role: "relation",
    label: "Node",
    labelPlural: "Nodes",
    hasColumns: true,
    hasSource: true,
    // NOT "yang": the installed editor registers 89 basic languages and YANG is not one of them,
    // measured against the bundle, and the fleet's gate refuses a language id the bundle does not
    // register (`tests/isolated/monaco-language-ids.test.ts`). The house's answer where a language
    // is unregistered is to declare the nearest REGISTERED id - Oracle renders under `sql` rather
    // than `plsql` - and YANG has no near relative among the 89, so highlighting it as `ini` or
    // `sql` would colour it wrongly. `plaintext`, which the editor core registers, says what is
    // true: this product shows the module's text and does not pretend to understand it.
    sourceLanguage: "plaintext",
  },
  {
    id: "key",
    role: "config",
    label: "Key",
    labelPlural: "Keys",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "xml",
  },
]);

/**
 * The key scan declaration. The separator is one UTF-16 code unit, which the level contract
 * requires, and the cursor is opaque because it carries a key path rather than a number.
 */
/**
 * The one separator this engine's key space uses, named so that the declaration below and the
 * level walk that has to split on it read the same constant rather than two copies of "/".
 */
export const NETCONF_KEY_SEPARATOR = "/";

export const NETCONF_KEY_SCAN: KeyScanCapability = Object.freeze<KeyScanCapability>({
  // A level page holds at most this many entries; the server answers a level unpaged and Studio
  // pages it, so the cap is Studio's and not the device's.
  defaultCount: 500,
  maxCount: 1_000,
  separator: NETCONF_KEY_SEPARATOR,
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "none",
  levels: {},
});

/** The kinds the object surface enumerates: the repository's `enumerableKinds()`, locally. */
export function enumerableKinds(kinds: readonly ObjectKindSpec[] = NETCONF_OBJECT_KINDS): readonly ObjectKindSpec[] {
  return kinds.filter((kind) => kind.enumeratedBy === undefined);
}

/** The one kind the Keys panel enumerates: the repository's `keyBrowserKind()`, locally. */
export function keyBrowserKind(kinds: readonly ObjectKindSpec[] = NETCONF_OBJECT_KINDS): ObjectKindSpec | undefined {
  return kinds.find((kind) => kind.enumeratedBy === "key-browser");
}

/**
 * The three rules the repository's own census enforces, asserted here as well so that a wrong
 * declaration fails in this directory rather than after a connection opens.
 *
 * Both of what it reads arrive as parameters defaulting to this module's own constants, so every
 * caller keeps calling it with none. They did not always: `kinds` was injected while the scan was
 * read from module scope, so under one name the function checked A declaration in one half and THE
 * declaration in the other. That is wrong about what it claims to do, whatever is testing it, and
 * the two scan guards being unreachable from a test was the symptom rather than the fault.
 */
export function assertDeclarationIsSound(
  kinds: readonly ObjectKindSpec[] = NETCONF_OBJECT_KINDS,
  scan: KeyScanCapability = NETCONF_KEY_SCAN,
): void {
  const browsers = kinds.filter((kind) => kind.enumeratedBy === "key-browser");
  if (browsers.length !== 1) {
    throw new Error(`exactly one kind is enumerated by the Keys panel, found ${browsers.length}`);
  }
  const browser = browsers[0];
  if (browser?.hasSource !== true) {
    throw new Error("the Keys panel kind needs hasSource, because its Source tab is what resolves it");
  }
  if (scan.levels === undefined) {
    throw new Error("a key-browser kind needs a keyScan declaration with levels");
  }
  if (scan.levels.rootKind !== undefined) {
    throw new Error("rootKind belongs to an engine with no container level, and this engine has two");
  }
  if (enumerableKinds(kinds).some((kind) => kind.id === browser?.id)) {
    throw new Error("the Keys panel kind must not also be enumerated by the object surface");
  }
}
