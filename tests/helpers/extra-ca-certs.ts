/**
 * The one way a test writes NODE_EXTRA_CA_CERTS in its own process.
 *
 * Studio reads the file the variable names once per process and keeps its certificates (`src/lib/db/trust-material.ts`),
 * so a plain write after the first read moves nothing. These helpers write the variable and forget the kept outcome, so
 * the next read decides as a new process started with that value would. Node.js itself read the variable when this
 * process started, so a write here never changes what Node's own TLS trusts. A child process's environment needs
 * neither: a child reads for itself.
 */
import { forgetTrustMaterial } from "@/lib/db/trust-material";

/** Sets the variable, or deletes it for `undefined`, then forgets the kept outcome. */
export function setExtraCaCerts(path: string | undefined): void {
  if (path === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = path;
  forgetTrustMaterial();
}

/** Sets the variable for `body`, then restores the value it found, forgetting the kept outcome both times. */
export async function withExtraCaCerts<T>(path: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_EXTRA_CA_CERTS;
  setExtraCaCerts(path);
  try {
    return await body();
  } finally {
    setExtraCaCerts(previous);
  }
}
