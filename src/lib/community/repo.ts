/**
 * The one place the public repository URL is written.
 *
 * It is referenced by the header/sidebar link, by the one-shot star toast and by
 * the standalone boot banner. Those three live in different runtimes (client
 * component, client module, server module), which is exactly how a rename ends up
 * fixed in the visible copies and missed in the rest.
 */
export const REPO_URL = "https://github.com/libredb/libredb-studio";
