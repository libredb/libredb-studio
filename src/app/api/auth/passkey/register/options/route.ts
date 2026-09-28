import { generateRegistrationOptions } from "@simplewebauthn/server";
import { isoUint8Array } from "@simplewebauthn/server/helpers";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import {
  getOrCreateWebAuthnUserId,
  getPasskeysForUser,
  saveRegistrationChallenge,
} from "@/lib/passkey/passkey-store";

const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function getRpId(request: Request): string {
  const configuredRpId = process.env.WEBAUTHN_RP_ID?.trim();

  if (configuredRpId) {
    return configuredRpId;
  }

  return new URL(request.url).hostname;
}

export async function GET(request: Request) {
  const session = await getSession();

  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  try {
    const userId = session.username;
    const webAuthnUserId = getOrCreateWebAuthnUserId(userId);
    const existingPasskeys = getPasskeysForUser(userId);

    const rpID = getRpId(request);
    const rpName =
      process.env.WEBAUTHN_RP_NAME?.trim() || "LibreDB Studio";

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: userId,
      userID: isoUint8Array.fromUTF8String(webAuthnUserId),
      attestationType: "none",

      excludeCredentials: existingPasskeys.map((passkey) => ({
        id: passkey.id,
      })),

      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
    });

    saveRegistrationChallenge(
      userId,
      options.challenge,
      Date.now() + REGISTRATION_CHALLENGE_TTL_MS,
    );

    return NextResponse.json(options);
  } catch (error) {
    console.error(
      "Failed to generate passkey registration options:",
      error,
    );

    return NextResponse.json(
      { error: "Unable to start passkey registration" },
      { status: 500 },
    );
  }
}