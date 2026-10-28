import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerS3CompletionProvider, s3CompletionBucketsOf } from "./editor-completions";
import { registerS3Language } from "./editor-syntax";

/**
 * The S3 command line, drawn over the console's own lexer. No formatter, Oxia's reason.
 *
 * Completion reads bucket names from the schema context only, never by a request, and an S3 connection's schema holds
 * no bucket, because S3 declares no relation kind, so it offers commands, flags and closed values only. Every insert is
 * quoted by the shared shell quoter.
 *
 * Indigo's `-alt` step: no guard reads an S3 command, so its draft stands beside the amber "not checked" chip, which
 * rules out yellow and orange; red is ruled out as a failure hue. Of the remaining declared `-alt` steps, indigo's
 * stands furthest from every status hue and every other language in both palettes (0.073 in OKLab from PromQL's
 * indigo, its nearest), measured.
 */
export const S3_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "s3",
  register: registerS3Language,
  completions: (monaco, context) => registerS3CompletionProvider(monaco, s3CompletionBucketsOf(context.schemaObjects)),
  accent: "border-hue-indigo-alt/40",
});
