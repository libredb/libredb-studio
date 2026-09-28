import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { NextResponse } from "next/server";

import { login } from "@/lib/auth";
import { getAuthUsers } from "@/lib/local-auth";
import {
  consumeAuthenticationChallenge,
  getPasskeyById,
  updatePasskeyCounter,
} from "@/lib/passkey/passkey-store";

interface AuthenticationRequestBody {
  sessionId?: string;
  response?: AuthenticationResponseJSON;
}

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
  try {
    const body = (await request.json()) as AuthenticationRequestBody;

    if (!body.sessionId || !body.response) {
      return NextResponse.json(
        { error: "Authentication session or response is missing" },
        { status: 400 },
      );
    }

    const expectedChallenge = consumeAuthenticationChallenge(body.sessionId);

    if (!expectedChallenge) {
      return NextResponse.json(
        { error: "Authentication challenge is missing or expired" },
        { status: 400 },
      );
    }

    const passkey = getPasskeyById(body.response.id);

    if (!passkey) {
      return NextResponse.json(
        { error: "Passkey is not registered" },
        { status: 404 },
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(request),
      expectedRPID: getRpId(request),
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    });

    if (!verification.verified) {
      return NextResponse.json(
        { error: "Passkey authentication could not be verified" },
        { status: 400 },
      );
    }

    const authUser = getAuthUsers().find(
      (user) => user.email === passkey.userId,
    );

    if (!authUser) {
      return NextResponse.json(
        { error: "Passkey user is no longer configured" },
        { status: 401 },
      );
    }

    updatePasskeyCounter(
      passkey.id,
      verification.authenticationInfo.newCounter,
    );

    await login(authUser.role, authUser.email);

    return NextResponse.json({
      verified: true,
      userId: authUser.email,
      role: authUser.role,
    });
  } catch (error) {
    console.error(
      "Failed to verify passkey authentication:",
      error,
    );

    return NextResponse.json(
      { error: "Invalid passkey authentication" },
      { status: 400 },
    );
  }
}