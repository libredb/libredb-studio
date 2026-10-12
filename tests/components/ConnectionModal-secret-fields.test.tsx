import "../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";

import { ConnectionModal } from "@/components/ConnectionModal";
import { getDBConfig, isFileBased, offersSshTunnel, offersSslPanel } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

/**
 * Every field of the connection dialog that holds a secret or key material keeps the browser's spell checker and
 * text assistance off: a spell checker can send the text to an outside service and keep its words in the user's
 * dictionary. The real dialog and the real form hook are walked through every engine, every SSL mode that shows the
 * PEM fields, both SSH auth methods, the connection-string mode and the Paste URL box, so a secret field added later
 * without the attributes fails here.
 */

MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);

type Field = HTMLInputElement | HTMLTextAreaElement;

/** A field is secret when it is masked, holds PEM text, or holds a URI that can carry a password. */
function isSecret(field: Field): boolean {
  if (field instanceof HTMLInputElement && field.type === "password") return true;
  const placeholder = field.getAttribute("placeholder") ?? "";
  if (placeholder.includes("-----BEGIN")) return true;
  if (field.id === "connectionString") return true;
  return placeholder.includes("://");
}

function keyOf(field: Field): string {
  return field.id || field.getAttribute("placeholder") || field.outerHTML;
}

function collect(found: Map<string, Field>) {
  for (const field of document.querySelectorAll<Field>("input, textarea")) {
    if (isSecret(field)) found.set(keyOf(field), field.cloneNode() as Field);
  }
}

function clickIfPresent(name: string) {
  const button = screen.queryByRole("button", { name });
  if (button) fireEvent.click(button);
}

function offending(found: Map<string, Field>): string[] {
  return [...found.values()]
    .filter((field) => {
      const masked = field instanceof HTMLInputElement && field.type === "password";
      return (
        field.getAttribute("spellcheck") !== "false" ||
        field.getAttribute("autocorrect") !== "off" ||
        field.getAttribute("autocapitalize") !== "off" ||
        field.getAttribute("autocomplete") !== (masked ? "new-password" : "off")
      );
    })
    .map(keyOf);
}

function renderDialog() {
  render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
}

// One test per engine, each on a fresh dialog: walked in one test, the thirty-odd engines ran past bun's five-second
// timeout on a loaded CI runner. Every field any test collects also lands here, for the reach check at the end.
const reached = new Map<string, Field>();

describe("the connection dialog's secret fields turn spell checking, autocorrect, autocapitalize and autocomplete off", () => {
  test("in the Paste URL box", () => {
    renderDialog();
    const found = new Map<string, Field>();
    fireEvent.click(screen.getByRole("button", { name: "Paste URL" }));
    collect(found);
    for (const [key, field] of found) reached.set(key, field);
    expect(offending(found)).toEqual([]);
  });

  test.each([...EXTERNAL_DATABASE_TYPES])("on %s", (type) => {
    renderDialog();
    const found = new Map<string, Field>();
    const button = screen.queryByRole("button", { name: getDBConfig(type).label });
    if (!button) return;
    fireEvent.click(button);
    collect(found);
    if (getDBConfig(type).showConnectionStringToggle) {
      fireEvent.click(screen.getByRole("button", { name: "Connection String" }));
      collect(found);
      fireEvent.click(screen.getByRole("button", { name: "Host / Port" }));
    }
    if (!isFileBased(type)) {
      if (offersSslPanel(type)) {
        if (!screen.queryByRole("button", { name: "verify-full" })) clickIfPresent("SSL / TLS");
        fireEvent.click(screen.getByRole("button", { name: "verify-full" }));
        collect(found);
      }
      if (offersSshTunnel(type)) {
        if (!screen.queryByText("Enable SSH Tunnel")) clickIfPresent("SSH Tunnel");
        const enable = screen.getByRole("checkbox", { name: "Enable SSH Tunnel" }) as HTMLInputElement;
        if (!enable.checked) fireEvent.click(enable);
        fireEvent.click(screen.getByRole("button", { name: "Password" }));
        collect(found);
        fireEvent.click(screen.getByRole("button", { name: "Private Key" }));
        collect(found);
      }
    }
    for (const [key, field] of found) reached.set(key, field);
    expect(offending(found)).toEqual([]);
  });

  // Runs after the tests above, in file order: the walk reached every kind of secret field the dialog has today.
  test("and the walk above reached every kind of secret field", () => {
    const keys = [...reached.keys()];
    for (const expected of [
      "password",
      "apiKeySecret",
      "connectionString",
      "••••••••",
      "Key passphrase (if encrypted)",
    ]) {
      expect(keys).toContain(expected);
    }
    expect(keys.filter((k) => k.includes("-----BEGIN")).length).toBe(4);
    expect(keys.some((k) => k.startsWith("postgres://"))).toBe(true);
  });
});
