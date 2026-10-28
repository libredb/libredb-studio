import "../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConnectionFieldControl, ConnectionFieldGroupRow } from "@/components/ConnectionFieldControl";
import type { ConnectionFormSpec } from "@/lib/db/connection-form";
import type { ConnectionField } from "@/lib/db/connection-fields";

/**
 * The one renderer every connection field the dialog does not lay out itself is drawn by: each control kind a
 * descriptor names, the engine's declared copy over the descriptor's own words, and the rows that hold more than one
 * field. The dialog's per-engine forms are held by tests/unit/db/connection-form/golden.test.tsx.
 */

afterEach(cleanup);

function spec(extra: Partial<ConnectionFormSpec> = {}): ConnectionFormSpec {
  return {
    label: "Probe",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: ["host", "user", "password"],
    ...extra,
  };
}

function draw(field: ConnectionField, value = "", config = spec(), extra: { credentialWarning?: string } = {}) {
  const onChange = mock<(field: ConnectionField, value: string) => void>(() => {});
  const view = render(
    <ConnectionFieldControl
      config={config}
      field={field as never}
      value={value}
      onChange={onChange}
      credentialWarning={extra.credentialWarning}
    />,
  );
  return { ...view, onChange };
}

describe("a text field", () => {
  test("draws the dialog's own label and example, and reports what is typed", () => {
    const { container, onChange } = draw("user");
    expect(container.querySelector('label[for="user"]')?.textContent).toBe("Username");
    const box = container.querySelector("input#user") as HTMLInputElement;
    expect(box.placeholder).toBe("user");
    expect(box.getAttribute("autocomplete")).toBe("off");
    expect(box.getAttribute("spellcheck")).toBe("false");
    expect(box.getAttribute("autocapitalize")).toBe("off");
    expect(box.getAttribute("aria-required")).toBeNull();
    fireEvent.change(box, { target: { value: "ada" } });
    expect(onChange).toHaveBeenCalledWith("user", "ada");
  });

  test("draws the engine's declared label, example and hint, and marks a required field", () => {
    const config = spec({
      fieldLabels: { user: "Login" },
      fieldPlaceholders: { user: "ada" },
      fieldHints: { user: "The login name." },
      fieldRules: { user: { required: "Login is required." } },
    });
    const { container } = draw("user", "", config);
    const label = container.querySelector('label[for="user"]') as HTMLLabelElement;
    expect(label.textContent).toBe("Login");
    expect(label.className).toContain("after:content-['*']");
    const box = container.querySelector("input#user") as HTMLInputElement;
    expect(box.placeholder).toBe("ada");
    expect(box.getAttribute("aria-required")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe("user-hint");
    expect(screen.getByTestId("user-hint").textContent).toBe("The login name.");
  });

  test("masks a secret and never offers a saved site password for it", () => {
    const { container } = draw("password");
    const box = container.querySelector("input#password") as HTMLInputElement;
    expect(box.type).toBe("password");
    expect(box.getAttribute("autocomplete")).toBe("new-password");
    expect(box.placeholder).toBe("***");
  });

  test("draws no placeholder where the descriptor has no example, whatever the engine declares", () => {
    const { container } = draw("warehouse", "", spec({ fieldPlaceholders: { warehouse: "ignored" } }));
    expect(container.querySelector("input#warehouse")?.hasAttribute("placeholder")).toBe(false);
  });

  test("leaves spell check and autofill to the browser for a free field, and asks for digits for a numeric one", () => {
    const free = draw("authSource").container.querySelector("input#authSource") as HTMLInputElement;
    expect(free.hasAttribute("autocomplete")).toBe(false);
    expect(free.hasAttribute("spellcheck")).toBe(false);
    cleanup();
    const unfilled = draw("apiKeyId").container.querySelector("input#apiKeyId") as HTMLInputElement;
    expect(unfilled.getAttribute("autocomplete")).toBe("off");
    expect(unfilled.hasAttribute("spellcheck")).toBe(false);
    cleanup();
    const numeric = draw("amqpPort").container.querySelector("input#amqpPort") as HTMLInputElement;
    expect(numeric.getAttribute("inputmode")).toBe("numeric");
    expect(numeric.getAttribute("spellcheck")).toBe("false");
    expect(numeric.hasAttribute("autocapitalize")).toBe(false);
  });

  test("draws a compact field with no icon and no label association", () => {
    const { container, onChange } = draw("serviceName", "svc");
    expect(container.querySelector("label")?.hasAttribute("for")).toBe(false);
    const box = container.querySelector("input") as HTMLInputElement;
    expect(box.id).toBe("");
    expect(box.placeholder).toBe("ORCL or XEPDB1");
    expect(box.className).toContain("h-9");
    fireEvent.change(box, { target: { value: "orcl" } });
    expect(onChange).toHaveBeenCalledWith("serviceName", "orcl");
  });

  test("draws the dialog's note only while the engine declares no example of its own", () => {
    draw("schema");
    expect(screen.queryByText(/Run SHOW SCHEMAS/)).not.toBeNull();
    cleanup();
    draw("schema", "", spec({ fieldPlaceholders: { schema: "public" } }));
    expect(screen.queryByText(/Run SHOW SCHEMAS/)).toBeNull();
  });

  test("draws the credential warning under the field that carries it, and nowhere else", () => {
    draw("password", "", spec(), { credentialWarning: "Careful." });
    expect(screen.getByTestId("credential-warning").textContent).toBe("Careful.");
    cleanup();
    draw("user", "", spec(), { credentialWarning: "Careful." });
    expect(screen.queryByTestId("credential-warning")).toBeNull();
  });
});

describe("a select", () => {
  const options = {
    saslMechanism: [{ value: "plain", label: "PLAIN" }],
    authMethod: [{ value: "pat", label: "Token" }],
  };

  test("offers None before the engine's choices where the descriptor says so", () => {
    const { container, onChange } = draw("saslMechanism", "", spec({ fieldOptions: options }));
    const select = container.querySelector("select#saslMechanism") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["None", "PLAIN"]);
    fireEvent.change(select, { target: { value: "plain" } });
    expect(onChange).toHaveBeenCalledWith("saslMechanism", "plain");
  });

  test("offers only the engine's choices for a field that always holds one, and none where it declares none", () => {
    const { container } = draw("authMethod", "pat", spec({ fieldOptions: options }));
    expect(Array.from((container.querySelector("select") as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      "pat",
    ]);
    cleanup();
    const bare = draw("authMethod", "", spec()).container.querySelector("select") as HTMLSelectElement;
    expect(bare.options.length).toBe(0);
  });
});

describe("a toggle", () => {
  test("presses the choice the provider makes for an empty value, and reports a pressed one", () => {
    const { container, onChange } = draw("securityMode", "");
    const fieldset = container.querySelector("fieldset#securityMode") as HTMLFieldSetElement;
    expect(fieldset.getAttribute("aria-label")).toBe("Security mode");
    const pressed = Array.from(fieldset.querySelectorAll("button")).map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["false", "false", "true"]);
    fireEvent.click(screen.getByText("Sign"));
    expect(onChange).toHaveBeenCalledWith("securityMode", "Sign");
  });

  test("presses the stored choice", () => {
    const { container } = draw("securityMode", "None");
    const pressed = Array.from(container.querySelectorAll("button")).map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "false", "false"]);
  });
});

describe("a text area", () => {
  test("draws a verbatim multi-line box of the declared height", () => {
    const { container, onChange } = draw("registerMap", "{}");
    const area = container.querySelector("textarea#registerMap") as HTMLTextAreaElement;
    expect(area.getAttribute("rows")).toBe("6");
    expect(area.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(area, { target: { value: "[]" } });
    expect(onChange).toHaveBeenCalledWith("registerMap", "[]");
  });
});

describe("a private key", () => {
  test("hides an entered key until Show key, and empties the box on Replace key", () => {
    const { container, onChange } = draw("privateKey", "not-a-real-key");
    expect(screen.getByTestId("privateKey-stored")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    fireEvent.click(screen.getByText("Replace key"));
    expect(onChange).toHaveBeenCalledWith("privateKey", "");
  });

  test("draws an empty key box, required where the engine requires it", () => {
    const config = spec({ fieldRules: { privateKey: { required: "Key is required." } } });
    const { container, onChange } = draw("privateKey", "", config);
    const box = container.querySelector("textarea#privateKey") as HTMLTextAreaElement;
    expect(box.getAttribute("aria-required")).toBe("true");
    fireEvent.change(box, { target: { value: "x" } });
    expect(onChange).toHaveBeenCalledWith("privateKey", "x");
  });
});

describe("a row of fields", () => {
  test("draws its fields side by side, a lone one across the row, and the group's note", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <ConnectionFieldGroupRow
        config={spec()}
        group="apiKey"
        fields={["apiKeyId", "apiKeySecret"]}
        values={{ apiKeyId: "", apiKeySecret: "" }}
        onChange={onChange}
      />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toBe("grid grid-cols-1 md:grid-cols-2 gap-4");
    expect(row.children.length).toBe(3);
    expect(screen.getByText(/Kibana shows this pair/)).not.toBeNull();
    cleanup();
    const lone = render(
      <ConnectionFieldGroupRow
        config={spec()}
        group="login"
        fields={["password"]}
        values={{ password: "" }}
        onChange={onChange}
      />,
    ).container.firstElementChild as HTMLElement;
    expect(lone.children.length).toBe(1);
    expect((lone.firstElementChild as HTMLElement).className).toBe("space-y-2 md:col-span-2");
  });

  test("draws an always-drawn row with none of its fields as an empty row", () => {
    const { container } = render(
      <ConnectionFieldGroupRow config={spec()} group="login" fields={[]} values={{}} onChange={() => {}} />,
    );
    expect((container.firstElementChild as HTMLElement).children.length).toBe(0);
  });
});
