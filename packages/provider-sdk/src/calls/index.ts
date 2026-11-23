/**
 * The provider contract's calls (docs/providers/CONTRACT.md, the calls chapter): the shapes of the mandatory calls and
 * the optional console facets, the contexts the host passes them, `defineProvider` and `checkProviderModule`, which
 * make and check the record a package's entry default-exports, and `envReader`, the declared environment behind
 * `ctx.env`.
 */
export {
  checkProviderModule,
  DEFINITION_REFUSAL_RULES,
  type DefinitionRefusal,
  type DefinitionRefusalRule,
  defineProvider,
  definitionRefusalSentence,
  ProviderDefinitionError,
} from "./define-provider";
export { type EnvReader, envReader, UndeclaredEnvironmentError } from "./env";
export * from "./types";
