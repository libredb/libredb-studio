import "../../../setup-dom";

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

import { ConnectionModal } from "@/components/ConnectionModal";
import { useConnectionForm } from "@/hooks/use-connection-form";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { filterByRoles } from "@/lib/seed/connection-filter";
import type { SeedConnection } from "@/lib/seed/types";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

import { seedBase, seedIssues } from "../connection-string/fixtures";

/**
 * Today's connection form per engine, with the real dialog, the real form hook and the real field declarations, as
 * `tests/components/ConnectionModal-snowflake.test.tsx` renders it: every label, box, button and hint line in document
 * order, the Advanced accordion open and the connection-string mode where the engine draws them, the connection a
 * Test Connection sends, and the seed refusals of the fields another engine owns.
 */
export const FORM_KEYS: readonly DatabaseType[] = Object.freeze([...EXTERNAL_DATABASE_TYPES, "libredb"]);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const attr = (element: Element, name: string): string => {
  const value = element.getAttribute(name);
  return value === null ? "none" : JSON.stringify(value);
};

function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "label") return `label[for=${element.getAttribute("for") ?? "none"}] ${JSON.stringify(text(element))}`;
  if (tag === "button") {
    return `button ${JSON.stringify(element.getAttribute("aria-label") ?? text(element))}`;
  }
  if (tag === "p") return `p#${element.id || "none"} ${JSON.stringify(text(element))}`;
  const type = tag === "input" ? ` type=${attr(element, "type")}` : "";
  return `${tag}#${element.id || "none"}${type} placeholder=${attr(element, "placeholder")} describedby=${attr(element, "aria-describedby")}`;
}

/**
 * The buttons whose name, as `describeElement` writes it, is `name`. A by-name role query computes every button's
 * accessible name and was three quarters of each render's time; the goldens hold this to the same buttons.
 */
function buttonsNamed(name: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button) => (button.getAttribute("aria-label") ?? text(button)) === name,
  );
}

function dialogLines(): string[] {
  return Array.from(
    screen.getByRole("dialog").querySelectorAll("label, input, textarea, select, button, p.text-xs"),
  ).map(describeElement);
}

function sortedKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

async function buildLines(type: DatabaseType): Promise<string[]> {
  const sent: DatabaseConnection[] = [];
  const onTestConnection = async (connection: DatabaseConnection) => {
    sent.push(connection);
    return { success: true };
  };
  const { result, unmount } = renderHook(() =>
    useConnectionForm({ isOpen: true, onClose: () => {}, onConnect: () => {}, editConnection: null, onTestConnection }),
  );
  act(() => result.current.setType(type));
  act(() => {
    result.current.setServiceName("svc");
    result.current.setInstanceName("inst");
    result.current.setLocalDataCenter("dc1");
    result.current.setAuthSource("admin");
    result.current.setApiKeyId("kid");
    result.current.setApiKeySecret("ksec");
  });
  await act(async () => {
    await result.current.handleTestConnection();
  });
  const lines =
    sent.length === 0
      ? [`not sent => ${JSON.stringify(result.current.testResult?.message ?? null)}`]
      : sent.map((connection) => {
          const rest: Record<string, unknown> = { ...connection };
          delete rest.id;
          delete rest.createdAt;
          return JSON.stringify(sortedKeys(rest));
        });
  unmount();
  return lines;
}

function filterLine(conn: Record<string, unknown>): string {
  try {
    filterByRoles([conn as SeedConnection], ["user"]);
    return "ok";
  } catch (error) {
    return `throws ${JSON.stringify((error as Error).message)}`;
  }
}

function seedForeignLines(type: DatabaseType): string[] {
  const base = seedBase(type);
  return [
    JSON.stringify(
      seedIssues({
        ...base,
        securityMode: "Sign",
        serverCertificateThumbprint: "aa",
        securityPolicyUri: "u",
        clientCertificatePath: "/c",
        clientPrivateKeyPath: "/k",
        apiKeyId: "kid",
        apiKeySecret: "ksec",
      }),
    ),
    JSON.stringify(seedIssues({ ...base, apiKeySecret: "ksec" })),
    filterLine({ ...base, roles: ["*"], apiKeyId: "kid" }),
    filterLine({ ...base, roles: ["*"], apiKeyId: "" }),
  ];
}

export async function renderFormGolden(type: DatabaseType): Promise<string> {
  // As in ConnectionModal-snowflake.test.tsx: without Element.animate motion drives its animations from its own frame
  // loop rather than through happy-dom's Web Animations, so the Advanced accordion opens within the act below.
  const nativeAnimate = Element.prototype.animate;
  Reflect.deleteProperty(Element.prototype, "animate");
  const lines: string[] = [];
  try {
    render(
      <ConnectionModal
        isOpen
        onClose={() => {}}
        onConnect={() => {}}
        onTestConnection={async () => ({ success: true })}
      />,
    );
    const [picker, ...others] = buttonsNamed(DB_UI_CONFIG[type].label);
    if (picker === undefined || others.length > 0) throw new Error(`not exactly one ${type} picker button drawn`);
    fireEvent.click(picker);
    lines.push("== discrete", ...dialogLines());

    const [advanced, ...moreAdvanced] = buttonsNamed("Advanced");
    if (moreAdvanced.length > 0) throw new Error(`more than one Advanced button drawn for ${type}`);
    if (advanced !== undefined) {
      await act(async () => {
        fireEvent.click(advanced);
      });
      lines.push("== advanced open", ...dialogLines());
    }

    if (DB_UI_CONFIG[type].showConnectionStringToggle) {
      // The mode toggle's own button, the one beside "Host / Port", not any other button of the same name.
      const toggle = buttonsNamed("Connection String").find(
        (button) => button.previousElementSibling?.textContent?.trim() === "Host / Port",
      );
      if (toggle === undefined) throw new Error(`no connection-string toggle drawn for ${type}`);
      await act(async () => {
        fireEvent.click(toggle);
      });
      lines.push("== connection string", ...dialogLines());
    }
  } finally {
    cleanup();
    Element.prototype.animate = nativeAnimate;
  }

  lines.push("== build", ...(await buildLines(type)));
  lines.push("== seed foreign fields", ...seedForeignLines(type));
  return `${lines.join("\n")}\n`;
}
