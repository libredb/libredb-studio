"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";

import { appFetch } from "@/lib/config/base-path";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function PasskeyRegistration() {
  const [isLoading, setIsLoading] = useState(false);

  const handleRegisterPasskey = async () => {
    if (isLoading) {
      return;
    }

    setIsLoading(true);

    try {
      const optionsResponse = await appFetch(
        "/api/auth/passkey/register/options",
      );
      const optionsData = await optionsResponse.json();

      if (!optionsResponse.ok) {
        throw new Error(
          optionsData.error || "Unable to start passkey registration",
        );
      }

      const registrationResponse = await startRegistration({
        optionsJSON: optionsData,
      });
      console.log("PASSKEY REGISTRATION RESPONSE:", registrationResponse);

      const verifyResponse = await appFetch(
        "/api/auth/passkey/register/verify",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(registrationResponse),
        },
      );

      const verifyData = await verifyResponse.json();

      if (!verifyResponse.ok) {
        throw new Error(
          verifyData.error || "Unable to register passkey",
        );
      }

      window.alert("Passkey registered successfully.");
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "NotAllowedError"
      ) {
        window.alert("Passkey registration was cancelled.");
        return;
      }

      console.error("Passkey registration failed:", error);

      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to register passkey",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DropdownMenuItem
      onClick={handleRegisterPasskey}
      disabled={isLoading}
      className="cursor-pointer"
    >
      <KeyRound strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" />
      {isLoading ? "Registering passkey..." : "Register Passkey"}
    </DropdownMenuItem>
  );
}