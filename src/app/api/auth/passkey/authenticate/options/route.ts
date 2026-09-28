import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { saveAuthenticationChallenge } from "@/lib/passkey/passkey-store";

const AUTHENTICATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function getRpId(request: Request): string {
  const configuredRpId = process.env.WEBAUTHN_RP_ID?.trim();

  if (configuredRpId) {
    return configuredRpId;
  }

  return new URL(request.url).hostname;
}

export async function GET(request: Request) {
  try {
    const rpID = getRpId(request);

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
    });

    const sessionId = randomUUID();

    saveAuthenticationChallenge(
      sessionId,
      options.challenge,
      Date.now() + AUTHENTICATION_CHALLENGE_TTL_MS,
    );

    return NextResponse.json({
      sessionId,
      options,
    });
  } catch (error) {
    console.error(
      "Failed to generate passkey authentication options:",
      error,
    );

    return NextResponse.json(
      { error: "Unable to start passkey authentication" },
      { status: 500 },
    );
  }
}