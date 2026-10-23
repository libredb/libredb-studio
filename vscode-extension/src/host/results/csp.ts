// The Results view's one CSP allowance by hash (part 4's shim table, the Radix ScrollArea row).

/**
 * The CSP source for the one fixed <style> ScrollArea's viewport renders without a nonce: 'sha256-<base64>'.
 * @radix-ui/react-scroll-area 1.4.0 (the root install's) renders ScrollAreaViewportStyle with a nonce only from a
 * `nonce` prop, which src/components/ui/scroll-area.tsx does not pass, so RowDetailSheet's ScrollArea emits
 * `[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}`
 * `[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}` (one text, no space between the two rules).
 * test/unit/results/html.test.ts recomputes it from the installed package, so a Radix bump that changes it fails there.
 */
export const RADIX_SCROLL_AREA_STYLE_HASH = "sha256-vGQdhYJbTuF+M8iCn1IZCHpdkiICocWHDq4qnQF4Rjw=";
