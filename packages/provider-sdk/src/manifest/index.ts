/**
 * The provider manifest: its types, generated from `manifest.schema.json`, the schema's digest, and the validator that
 * reads a manifest against it (docs/providers/CONTRACT.md). The schema file itself is published as
 * `@libredb/provider-sdk/manifest.schema.json`, so a host, the kit and a test read the one file by package name.
 */
export * from "./manifest-types.generated";
export {
  compileManifestValidator,
  type ContractRefusal,
  type EngineVerdict,
  type ManifestRefusal,
  ManifestSchemaDigestError,
  type ManifestValidator,
  type ManifestVerdict,
  refusalSentence,
  SCHEMA_REFUSAL_RULES,
  type SchemaRefusal,
  type SchemaRefusalRule,
} from "./validate";
