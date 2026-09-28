import {
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import {
  consumeRegistrationChallenge,
  savePasskey,
} from "@/lib/passkey/passkey-store";

function getRpId(request: Request): string {
  const configuredRpId = process.env.WEBAUTHN_RP_ID?.trim();

  if (configuredRpId) {
    return configuredRpId;
  }

  return new URL(request.url).hostname;
}

function getExpectedOrigin(request: Request): string {
  const configuredOrigin = process.env.WEBAUTHN_ORIGIN?.trim();

  if (configuredOrigin) {
    return configuredOrigin;
  }

  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  const session = await getSession();

  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const userId = session.username;

  try {
    const requestBody: unknown = await request.json();

const body = (
  typeof requestBody === "object" &&
  requestBody !== null &&
  "id" in requestBody
    ? requestBody
    : typeof requestBody === "object" &&
        requestBody !== null &&
        "response" in requestBody
      ? requestBody.response
      : requestBody
) as RegistrationResponseJSON;

    const expectedChallenge = consumeRegistrationChallenge(userId);

    if (!expectedChallenge) {
      return NextResponse.json(
        { error: "Registration challenge is missing or expired" },
        { status: 400 },
      );
    }

    const rpID = getRpId(request);
    const expectedOrigin = getExpectedOrigin(request);

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json(
        { error: "Passkey registration could not be verified" },
        { status: 400 },
      );
    }

    const { credential } = verification.registrationInfo;

    savePasskey({
      id: credential.id,
      userId,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({
      verified: true,
    });
  } catch (error) {
    console.error("Failed to verify passkey registration:", error);

    return NextResponse.json(
      { error: "Invalid passkey registration" },
      { status: 400 },
    );
  }
}
