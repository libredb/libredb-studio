/**
 * @file The one SHA-256 over a JavaScript string's UTF-16 code units, for every token that seals text a client sent:
 * the object edit plan token (`src/lib/api/object-edit-plan-token.ts`) and the run confirmation token
 * (`src/lib/api/run-confirmation-token.ts`). One definition, so the two seals cannot disagree about what a string's
 * bytes are.
 */

/**
 * SHA-256 over the input's UTF-16 CODE UNITS, lowercase hex, through Web Crypto so this works in
 * every runtime this tree targets.
 *
 * NOT `new TextEncoder().encode(input)`, and the reason is ruling 1a in the letter. MEASURED by
 * round 1 review against the shipped module: `TextEncoder` maps every UNPAIRED surrogate to
 * U+FFFD, while `JSON.stringify`/`JSON.parse` on the wire preserves the code unit, so a token
 * minted for a statement text `"A\uD800B"` answered `{ valid: true }` for a plan carrying
 * `"A\uDC00B"`. The bytes the user approved would not have been the bytes the engine received.
 * Two bytes per code unit is injective over every JavaScript string, lone surrogates included.
 *
 * MEASURED cost, bun 1.4.2 on this machine, over an input the size of the largest definition the
 * browser probe opened (975,134 characters): one whole `digestPlan` over that plan, loop included,
 * is 3.60 ms, mean of five runs after a warm-up, which is well inside one apply's budget. Measured again for
 * the run confirmation token, bun 1.4.4: 16 ms (median) over 10,000,000 code units, the size of the largest run
 * request body Studio reads.
 */
export async function sha256Hex(input: string): Promise<string> {
  const units = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    units[index * 2] = code >>> 8;
    units[index * 2 + 1] = code & 0xff;
  }
  const digest = await crypto.subtle.digest("SHA-256", units);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
