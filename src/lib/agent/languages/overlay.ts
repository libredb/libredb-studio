/**
 * `defineOverlay` (#1821): one facet of a family pack with an engine's overlay applied. Client tier and a leaf: it
 * loads nothing at run time, so every tier may read it.
 *
 * Applied facet by facet, member by member. A function in the overlay is called with the base member and its result
 * becomes the member; any other value replaces the member whole. Values are never merged, so an overlay that gives a
 * record gives all of it. Every member the overlay leaves alone keeps its reference, and an overlay with no own key is
 * no overlay: the base comes back itself.
 *
 * `dialectOnly` is what the client registry (`engines/client.ts`) keeps of an engine module's overlay: its `dialect`
 * and nothing else. The server registry (`engines/server.ts`) keeps the whole overlay, whose other members are the ones
 * `ENGINE_OVERRIDABLE_SERVER_MEMBERS` names.
 */
import type { FacetOverrides } from "./pack";

/**
 * The server members an engine overlay may override besides its `dialect` (`AgentEngineServerOverlay`): exactly the
 * members every consumer reads through the run resolver (`runServerPack` in `engines/server.ts`), so an override
 * reaches every reader. Every other member stays its family's:
 *
 * - `adapter` (with its `inventoryProblem` and `planDraftIdentifiers`) and `catalogAdvice` are read through
 *   `AuditedAgentCall.fingerprintLanguage` and `draftedStatement(input, language)`, which carry no engine, and step
 *   ids and repair identity depend on them (B128);
 * - `toolOverrides`, `recommendationCard` and the statement definitions make the offer, which is computed from the
 *   run record with no connection, and a card's schema must equal the offered one;
 * - `baseDefinitions`, `shortfallNotices`, `usageBarNotice`, `usageBarTool` and `evidenceTools` are merged by name
 *   across every family in `languages/server.ts`.
 *
 * Client overlays stay dialect-only: `copy`, `variants` and `planEstimateOperation` are projected per family into
 * browser tables, and `posture.handoverTerms` is read by language (B123).
 */
export const ENGINE_OVERRIDABLE_SERVER_MEMBERS = Object.freeze([
  "grounding",
  "workflowToolRules",
  "answerNotADataRead",
] as const);

/**
 * `base` with `overlay` applied, frozen. `A` carries members the base lacks, such as an engine's `dialect`; a member the
 * base holds keeps the base's type, whether the overlay gave a value or a derivation.
 */
export function defineOverlay<B extends object, A extends object = Record<never, never>>(
  base: B,
  overlay?: FacetOverrides<B> & A,
): Readonly<B & Omit<A, keyof B>> {
  if (overlay === undefined || Object.keys(overlay).length === 0) return base as Readonly<B & Omit<A, keyof B>>;
  const resolved: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(overlay)) {
    resolved[key] = typeof member === "function" ? member((base as Record<string, unknown>)[key]) : member;
  }
  return Object.freeze({ ...base, ...resolved }) as Readonly<B & Omit<A, keyof B>>;
}

/** An overlay with its `dialect` alone, or with nothing for a family that has none. */
type DialectOnly<Overlay> = Overlay extends { readonly dialect: infer Dialect }
  ? { readonly dialect: Dialect }
  : Record<never, never>;

/** The `dialect` of an engine module's overlay, and nothing else it holds, frozen like the dialect inside it. */
export const dialectOnly = <Overlay extends { readonly dialect?: object }>(overlay: Overlay): DialectOnly<Overlay> =>
  Object.freeze(overlay.dialect === undefined ? {} : { dialect: overlay.dialect }) as DialectOnly<Overlay>;
