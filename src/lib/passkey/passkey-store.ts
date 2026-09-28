import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDir } from "@/lib/data-dir";

export const PASSKEY_STORE_FILE_NAME = "auth-passkeys.json";
const PASSKEY_STORE_VERSION = 1;

export interface StoredPasskey {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

interface StoredChallenge {
  challenge: string;
  expiresAt: number;
}

interface PasskeyStoreFile {
  version: number;
  credentials: StoredPasskey[];
  registrationChallenges: Record<string, StoredChallenge>;
  authenticationChallenges: Record<string, StoredChallenge>;
  userIds: Record<string, string>;
}

const EMPTY_STORE: PasskeyStoreFile = {
  version: PASSKEY_STORE_VERSION,
  credentials: [],
  registrationChallenges: {},
  authenticationChallenges: {},
  userIds: {},
};

export function resolvePasskeyStorePath(): string {
  return path.resolve(getDataDir(), PASSKEY_STORE_FILE_NAME);
}

function readStore(): PasskeyStoreFile {
  const filePath = resolvePasskeyStorePath();

  if (!fs.existsSync(filePath)) {
    return structuredClone(EMPTY_STORE);
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("passkey store is not a JSON object");
    }

    const store = parsed as Partial<PasskeyStoreFile>;

    if (
      store.version !== PASSKEY_STORE_VERSION ||
      !Array.isArray(store.credentials) ||
      typeof store.registrationChallenges !== "object" ||
      store.registrationChallenges === null ||
      Array.isArray(store.registrationChallenges) ||
      typeof store.authenticationChallenges !== "object" ||
      store.authenticationChallenges === null ||
      Array.isArray(store.authenticationChallenges) ||
      typeof store.userIds !== "object" ||
      store.userIds === null ||
      Array.isArray(store.userIds)
    ) {
      throw new Error("passkey store has an invalid shape");
    }

    return {
      version: PASSKEY_STORE_VERSION,
      credentials: store.credentials as StoredPasskey[],
      registrationChallenges: store.registrationChallenges as Record<string, StoredChallenge>,
      authenticationChallenges: store.authenticationChallenges as Record<string, StoredChallenge>,
      userIds: store.userIds as Record<string, string>,
    };
  } catch {
    throw new Error(`Unable to read passkey store at ${filePath}`);
  }
}

function writeStore(store: PasskeyStoreFile): void {
  const filePath = resolvePasskeyStorePath();
  const directory = path.dirname(filePath);

  fs.mkdirSync(directory, { recursive: true });

  const tempPath = `${filePath}.${process.pid}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });

  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    try {
      fs.copyFileSync(tempPath, filePath);

      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best effort on platforms where chmod is unavailable.
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

/**
 * Return the stable opaque WebAuthn user ID for a LibreDB account.
 *
 * The LibreDB account identifier (for example, an email address) is deliberately
 * not used as the WebAuthn user ID because the WebAuthn identifier should be
 * opaque and stable.
 */
export function getOrCreateWebAuthnUserId(userId: string): string {
  const store = readStore();
  const existing = store.userIds[userId];

  if (existing) {
    return existing;
  }

  const webAuthnUserId = randomUUID();

  store.userIds[userId] = webAuthnUserId;
  writeStore(store);

  return webAuthnUserId;
}

export function getPasskeysForUser(userId: string): StoredPasskey[] {
  return readStore().credentials.filter((credential) => credential.userId === userId);
}

export function getPasskeyById(id: string): StoredPasskey | undefined {
  return readStore().credentials.find((credential) => credential.id === id);
}

export function savePasskey(passkey: StoredPasskey): void {
  const store = readStore();

  if (store.credentials.some((credential) => credential.id === passkey.id)) {
    throw new Error("Passkey is already registered");
  }

  store.credentials.push(passkey);
  writeStore(store);
}

export function updatePasskeyCounter(id: string, counter: number): void {
  const store = readStore();
  const passkey = store.credentials.find((credential) => credential.id === id);

  if (!passkey) {
    throw new Error("Passkey not found");
  }

  passkey.counter = counter;
  passkey.lastUsedAt = new Date().toISOString();

  writeStore(store);
}

export function saveRegistrationChallenge(
  userId: string,
  challenge: string,
  expiresAt: number,
): void {
  const store = readStore();

  store.registrationChallenges[userId] = {
    challenge,
    expiresAt,
  };

  writeStore(store);
}

export function consumeRegistrationChallenge(userId: string): string | null {
  const store = readStore();
  const entry = store.registrationChallenges[userId];

  if (!entry) {
    return null;
  }

  delete store.registrationChallenges[userId];
  writeStore(store);

  if (entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.challenge;
}

export function saveAuthenticationChallenge(
  sessionId: string,
  challenge: string,
  expiresAt: number,
): void {
  const store = readStore();

  store.authenticationChallenges[sessionId] = {
    challenge,
    expiresAt,
  };

  writeStore(store);
}

export function consumeAuthenticationChallenge(sessionId: string): string | null {
  const store = readStore();
  const entry = store.authenticationChallenges[sessionId];

  if (!entry) {
    return null;
  }

  delete store.authenticationChallenges[sessionId];
  writeStore(store);

  if (entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.challenge;
}