/**
 * A capture records no credential value. The fixture answers a `<get-config>` of `running` with
 * the read-only account's own password hash, so the evidence recorder overwrites the text of every
 * credential element before it writes. Each character becomes an `x`, so every chunk keeps its
 * length: the chunked framing the replay reads counts the bytes each chunk carries, and the
 * elements' text is ASCII.
 */

const CREDENTIAL_ELEMENT =
  /<(hashed-password|cleartext-password|cleartext-private-key|cleartext-symmetric-key)>([^<]*)<\/\1>/g;

export function scrubCredentialValues(chunks: readonly string[]): string[] {
  const scrubbed = chunks
    .join("")
    .replace(
      CREDENTIAL_ELEMENT,
      (_whole, name: string, text: string) => `<${name}>${"x".repeat(text.length)}</${name}>`,
    );
  const out: string[] = [];
  let at = 0;
  for (const chunk of chunks) {
    out.push(scrubbed.slice(at, at + chunk.length));
    at += chunk.length;
  }
  return out;
}
