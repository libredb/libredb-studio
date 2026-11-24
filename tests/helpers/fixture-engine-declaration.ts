import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";

/**
 * The fixture engine of the removal tests (docs/providers/CONTRACT.md, clauses M-70, M-71, M-72, M-74, M-75 and M-77):
 * `base` declared as `acmefoo`, the id the FND-1 tests give a stored connection of an engine no provider serves, named
 * "Acme Foo", with a connect budget of 90 s.
 *
 * Its authored members differ from every shipped engine's in combination: it reads the trust material, offers a URI
 * mode in its dialog, takes two TLS modes only, `verify-system` and `verify-full`, a list no shipped engine declares,
 * refuses `schema` by name and warns about a connection with no secret, so its catalog entry and its connection rows
 * are ones no shipped engine has. Adding it to the admitted set adds exactly those rows, and removing it again is
 * visible in every projection that read it. It carries no credential value: its one warning is `no-secret`. It names no
 * function in its connection form: no host hint, host identity or import, and no field rule with a check, and none in
 * its connection string: no scheme, URL TLS reader, paste or seed check, whatever `base` names, so neither of Studio's
 * function tables holds anything for it and both its form and its connection string compose; a test that needs a named
 * function names one on a copy. Its editor commits with `APPLY`, has a consent deadline naming Acme Foo and one fence
 * alias of its own, `acmefooql`, so its execution UI entry is one no shipped engine has and it restates none of
 * `base`'s aliases, which the fence alias projection would refuse as declared twice (clause M-75). It states `base`'s
 * query dialect and editor language unchanged, so it adds no query editor entry, and restates none of them otherwise,
 * which the query editor projection would refuse as stated differently (clause M-77).
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
      connectionString: {
        ...base.connection.connectionString,
        dialogOffersUri: true,
        scheme: null,
        urlTls: null,
        paste: null,
        seedCheck: null,
      },
      tls: { modes: ["verify-system", "verify-full"] },
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
    editor: {
      ...base.editor,
      commitKeyword: "APPLY",
      consentDeadline: {
        chip: "Acme Foo: stopped at its deadline",
        sentence:
          "On Acme Foo a read that runs past its deadline is stopped by the server, which keeps no partial result.",
      },
      fenceAliases: ["acmefooql"],
    },
  };
}
