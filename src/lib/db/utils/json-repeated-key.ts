/**
 * Whether a key is written twice in the one JSON object a request holds.
 *
 * `JSON.parse` keeps the last of two equal keys without a word, so a reader that admitted a request by its parsed
 * value would read `{"read": "window", "read": "topic"}` as a topic read the model may not have meant. The agent
 * request readers refuse such a request instead, and this scan is how they find it: `text` is one object JSON.parse
 * has already accepted, the scan tells keys from values by the object they sit in, and it decodes each key's spelling
 * as JSON does, so `"t\u006fpic"` is `topic`.
 *
 * This lives under `db/utils` because several providers' agent readers need it and none may import from another's
 * directory; nothing here belongs to an engine, it is a property of JSON text and of `JSON.parse`.
 */
export function repeatsAKey(text: string): boolean {
  const open: { readonly keys: Set<string> | null; expectsKey: boolean }[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "{" || char === "[") open.push({ keys: char === "{" ? new Set() : null, expectsKey: char === "{" });
    else if (char === "}" || char === "]") open.pop();
    else if (char === ",") {
      const top = open.at(-1) as { readonly keys: Set<string> | null; expectsKey: boolean };
      top.expectsKey = top.keys !== null;
    } else if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = open.at(-1);
      if (top?.keys && top.expectsKey) {
        const key = JSON.parse(text.slice(at, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectsKey = false;
      }
      at = end;
    }
  }
  return false;
}
