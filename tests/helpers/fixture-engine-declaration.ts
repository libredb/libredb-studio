import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";

/**
 * The fixture engine of the removal tests (docs/providers/CONTRACT.md, clauses M-70 and M-71): `base` declared as
 * `acmefoo`, the id the FND-1 tests give a stored connection of an engine no provider serves, named "Acme Foo", with a
 * connect budget of 90 s.
 *
 * Its authored members differ from every shipped engine's in combination: it reads the trust material, offers a URI
 * mode in its dialog, refuses `schema` by name and warns about a connection with no secret, so its catalog entry and
 * its connection rows are ones no shipped engine has. Adding it to the admitted set adds exactly those rows, and
 * removing it again is visible in every projection that read it. It carries no credential value: its one warning is
 * `no-secret`. It names no function in its connection form: no host hint, host identity or import, and no field rule
 * with a check, so Studio's function table holds nothing for it and its form composes; a test that needs a named
 * function names one on a copy.
 */
export function fixtureEngineDeclaration(base: EngineDeclaration): EngineDeclaration {
  return {
    ...base,
    id: "acmefoo",
    displayName: "Acme Foo",
    connection: {
      ...base.connection,
      refused: [
        { field: "schema", refusal: "Acme Foo connections take no Schema: clear the field. Nothing was sent." },
      ],
      connectionString: { ...base.connection.connectionString, dialogOffersUri: true },
      readsTrustMaterial: true,
      credentialWarnings: [
        {
          kind: "no-secret",
          message:
            "An Acme Foo server accepts a connection with no password, so a read-only seed without one promises a boundary the server does not keep.",
        },
      ],
      connectBudgetMs: 90_000,
      fieldRules: base.connection.fieldRules.map((rule) => ({ ...rule, check: null })),
      hostHint: null,
      hostIdentity: null,
      import: null,
    },
  };
}
