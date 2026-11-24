import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";

/** The reason the fixture engine's migration DDL refusal line gives. */
const ACME_FOO_MIGRATION_REASON = "An Acme Foo store holds no tables, so there is no column definition to change.";

/**
 * The fixture engine of the removal tests (docs/providers/CONTRACT.md, clauses M-70, M-71, M-72, M-74, M-75, M-77,
 * M-78, M-79, M-80 and M-81):
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
 * which the query editor projection would refuse as stated differently (clause M-77). Its SQL text is `base`'s with one
 * trailing limit clause of its own after `base`'s, `\s+WITH\s+ACME\s+HINT\s*$`, so its entry is one no shipped
 * engine has, and it names no completion reader, whatever `base` names, so Studio's grammar function table holds
 * nothing for it and its grammar composes (clause M-78); its `sqlText.redaction` is `base`'s, a claim no projection
 * reads. Its SQL writing is `base`'s with the DDL text type `ACMETEXT` and the one standing-alone name `acmetext`, so
 * its entry is one no shipped engine has; its function names stay its slots' names, which Studio's SQL writing
 * function table holds for no `acmefoo`, so composing its row is refused by name, the answer a package's declaration
 * gets until a package fills a slot (clause M-79). Its migration DDL is the refused form with a refusal line and reason
 * of its own, so its entry is one no shipped engine has, and it names no function, so its row composes (clause M-80).
 * Its SQL generator forms name only its quoting, by its slot's name, with the count expression `COUNT_BIG(*)`, so its
 * entry is one no shipped engine has, and Studio's SQL generator function table holds no `generatorQuote` for
 * `acmefoo`, so composing its row is refused by name (clause M-81).
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
    sqlText: {
      ...base.sqlText,
      grammar: {
        ...base.sqlText.grammar,
        trailingLimitClauses: [
          ...base.sqlText.grammar.trailingLimitClauses,
          { source: String.raw`\s+WITH\s+ACME\s+HINT\s*$`, flags: "i" },
        ],
      },
      completion: { formatSegment: null, readQuotedQualifier: null },
    },
    sqlWriting: {
      ...base.sqlWriting,
      export: {
        ...base.sqlWriting.export,
        ddlTypes: { ...base.sqlWriting.export.ddlTypes, text: "ACMETEXT" },
        standsAlone: ["acmetext"],
      },
    },
    migrationDdl: {
      tableDdl: "refused",
      refusal: `-- Acme Foo: Cannot generate table DDL. ${ACME_FOO_MIGRATION_REASON}`,
      transactionWrapper: null,
      reasons: [ACME_FOO_MIGRATION_REASON],
    },
    sqlGenerators: {
      quote: "generatorQuote",
      table: null,
      select: null,
      selectList: null,
      countExpression: "COUNT_BIG(*)",
    },
  };
}
