/**
 * Seeds the built-in samples the way register() does, for a test that lists them: the listings offer only what
 * `startSampleSeeding` admitted at boot (src/lib/seed/samples.ts), so a test sets the environment first and seeds
 * after, as a server reads its environment once.
 *
 * Every sample the environment enables must have its path override set, so a seeding test never copies into the
 * repository's ./data: an enabled sample without one is an error naming its variable, before anything is copied. A
 * sample whose file the test put there is left as it is ("already present"); one without a file gets the committed
 * asset when the test sets SEED_ASSETS_DIR to the seed-assets directory, and fails as asset-directory-unset when it
 * is unset.
 */
import { SAMPLES, sampleEnabled, startSampleSeeding } from "@/lib/seed/samples";

export async function seedSamples(): Promise<void> {
  for (const [type, spec] of SAMPLES) {
    if (sampleEnabled(type, spec) && !process.env[spec.pathVariable]) {
      throw new Error(`seedSamples: ${spec.pathVariable} is not set, so seeding would copy into ./data`);
    }
  }
  await startSampleSeeding();
}
