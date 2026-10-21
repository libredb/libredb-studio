// Replaces @/lib/storage in the webview bundle (part 4's shim table): the view keeps its state through getState and
// setState and always passes maskingConfig, so loadMaskingConfig never runs, and a call that slips through fails loudly.
// It exports only storage, so a new import from that module fails the build.
function refuse(): never {
  throw new Error("The LibreDB Results view keeps no browser storage.");
}

export const storage: unknown = new Proxy({}, { get: refuse });
