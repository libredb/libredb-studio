import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  readS3Operations,
  S3_DESTRUCTIVE_OPERATIONS,
  s3Refusal,
} from "@/lib/db/providers/objectstore/s3/console/guard";
import { S3_MAX_TEXT_BYTES } from "@/lib/db/providers/objectstore/s3/console/constants";

/**
 * S3-compatible object storage's row of the confirmation gate's vocabulary.
 *
 * The provider's own guard reads the text with the parser the provider runs, so what asks and what runs are one
 * parse. v1 only reads, so nothing asks; what the guard refuses (a write command, an unknown flag, a bucket or key the
 * console cannot address) the editor refuses before anything is sent.
 */
export const S3_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: S3_DESTRUCTIVE_OPERATIONS,
  read: readS3Operations,
  decidesAlone: true,
  // A command names buckets and keys, so no S3 statement is posted for an AI analysis.
  safetyAnalysis: false,
  refuse: s3Refusal,
  maxTextBytes: S3_MAX_TEXT_BYTES,
};
