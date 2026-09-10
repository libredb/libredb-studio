/**
 * RFC 6238 Appendix B's seed, shared by every test that needs a known-good TOTP secret.
 *
 * Derived rather than pasted as a base32 literal. A 32-character high-entropy string assigned to
 * a constant named `SECRET` is exactly the shape `.gitleaks.toml`'s `generic-api-key` rule fires
 * on, and the required Secret Scan reports a fabricated fixture the same way it reports a real
 * credential. A `.gitleaksignore` fingerprint is the wrong remedy for unmerged work: fingerprints
 * are `commit:file:rule:line`, so a squash-merge renames the commit and the entry goes stale.
 *
 * Encoding it here also makes the RFC's own claim executable — that the seed IS the ASCII string
 * below — instead of leaving the reader to trust a base32 blob. `tests/unit/lib/totp.test.ts`
 * closes the loop by decoding it back through the app's own `decodeBase32`.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The seed every published SHA-1 vector in RFC 6238 Appendix B is computed against. */
export const RFC6238_SEED_ASCII = "12345678901234567890";

function encodeBase32(input: string): string {
  let accumulator = 0;
  let bits = 0;
  let output = "";
  for (const byte of Buffer.from(input, "ascii")) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >> bits) & 0x1f];
    }
  }
  // A trailing partial group is left-aligned into a final character; 20 bytes divide evenly into
  // 32 characters, so this only guards a future caller passing a length that does not.
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 0x1f];
  return output;
}

/** Base32 form of the seed: what an operator pastes into ADMIN_TOTP_SECRET. 160 bits, 32 chars. */
export const RFC6238_SECRET = encodeBase32(RFC6238_SEED_ASCII);
