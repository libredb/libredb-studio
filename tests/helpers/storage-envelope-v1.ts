import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Seals a value in the PREVIOUS stored credential format, `v1:<iv>:<ciphertext+tag>`, exactly as the release before
 * envelope v2 wrote it: AES-256-GCM under the HKDF-SHA256 key of STORAGE_ENCRYPTION_KEY, or JWT_SECRET when that is
 * unset, with an empty salt, the info string `libredb-studio/storage-encryption/v1`, a 12-byte random IV, the 16-byte
 * tag appended, and no additional authenticated data.
 *
 * It exists for upgrade tests only: a store a previous version wrote holds these values, and this version must read
 * them until the operator re-seal retires them (docs/STORAGE.md, "Upgrading to envelope v2"). No production code writes
 * this format any more, so the tests build it themselves rather than through a sealer the server keeps.
 */
export function sealVersionOne(plaintext: string): string {
  const material = process.env.STORAGE_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) throw new Error("sealVersionOne needs STORAGE_ENCRYPTION_KEY or JWT_SECRET in the environment");
  const key = Buffer.from(
    hkdfSync("sha256", new TextEncoder().encode(material), new Uint8Array(0), "libredb-studio/storage-encryption/v1", 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1:${iv.toString("base64url")}:${body.toString("base64url")}`;
}
