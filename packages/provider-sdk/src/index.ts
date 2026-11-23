/**
 * `@libredb/provider-sdk`: the provider contract of LibreDB Studio (docs/providers/CONTRACT.md). This entry is the whole
 * contract surface: the manifest (`@libredb/provider-sdk/manifest`) and the value codec
 * (`@libredb/provider-sdk/values`), each also published under its own name. `ValueTag` reaches this entry through both,
 * as the one binding the manifest types declare.
 */
export * from "./manifest";
export * from "./values";
