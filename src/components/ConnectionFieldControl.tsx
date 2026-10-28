"use client";

import { useState } from "react";
import { Database, Globe, Key, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { connectionFieldHint, connectionFieldLabel, connectionFieldPlaceholder } from "@/lib/db-ui-config";
import type { ConnectionFormSpec } from "@/lib/db/connection-form";
import {
  type BodyConnectionField,
  bodyFieldDescriptor,
  CONNECTION_FIELD_GROUPS,
  type ConnectionField,
  type ConnectionFieldGroupName,
  type ConnectionFieldIcon,
  type ConnectionFieldTyping,
} from "@/lib/db/connection-fields";

/**
 * The one renderer for every connection field the dialog does not lay out itself: it draws the control a field's
 * descriptor (src/lib/db/connection-fields.ts) names, with the engine's declared label, placeholder, hint, options and
 * required rule over the descriptor's own words, so a new field is a descriptor row and never markup in
 * `ConnectionModal.tsx`.
 */

const ICONS = {
  key: Key,
  shield: ShieldCheck,
  server: Server,
  globe: Globe,
  database: Database,
} as const satisfies Record<ConnectionFieldIcon, unknown>;

/** The browser behaviour each typing switches off, as the box's attributes. */
const TYPING_PROPS = {
  free: {},
  unfilled: { autoComplete: "off" },
  unchecked: { autoComplete: "off", spellCheck: false },
  verbatim: { autoComplete: "off", spellCheck: false, autoCorrect: "off", autoCapitalize: "off" },
  // Server credential, not the user's own login: "new-password" is the only value Chrome honours to keep saved site
  // passwords out of the field.
  secret: {
    type: "password",
    autoComplete: "new-password",
    spellCheck: false,
    autoCorrect: "off",
    autoCapitalize: "off",
  },
} as const satisfies Record<ConnectionFieldTyping, Record<string, string | boolean>>;

const LABEL_CLASS = "text-xs font-medium text-fg-muted";
const BOX_CLASS = "h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs";

/**
 * The id a declared field hint carries, which the field's input names in `aria-describedby`:
 * `<field>-hint`, the shape `queryTimeout-hint` already has in the dialog.
 */
export function fieldHintId(field: ConnectionField): string {
  return `${field}-hint`;
}

/** The `aria-describedby` a field's input carries: its declared hint's id, or none when the engine declares no hint. */
export function describedByHint(config: ConnectionFormSpec, field: ConnectionField): string | undefined {
  return connectionFieldHint(config, field) === undefined ? undefined : fieldHintId(field);
}

/**
 * The hint an engine DECLARES for one connection field (#1085), drawn under that field in the dialog's hint idiom:
 * the muted paragraph `ssl-mode-hint` is, with a test id, and an id the field's input names. Nothing is drawn where
 * the engine declares none.
 */
export function DeclaredFieldHint({
  config,
  field,
}: {
  readonly config: ConnectionFormSpec;
  readonly field: ConnectionField;
}) {
  const hint = connectionFieldHint(config, field);
  if (hint === undefined) return null;
  return (
    <p id={fieldHintId(field)} data-testid={fieldHintId(field)} className="text-xs text-fg-muted">
      {hint}
    </p>
  );
}

/**
 * A field Test refuses empty (its declared rule has `required`), marked on its label with an asterisk drawn by CSS,
 * so the label's text stays the field's name, and on its box with `aria-required` (SF-043).
 */
function isRequired(config: ConnectionFormSpec, field: ConnectionField): boolean {
  return config.fieldRules?.[field]?.required !== undefined;
}

function labelClass(config: ConnectionFormSpec, field: ConnectionField): string {
  return cn(LABEL_CLASS, isRequired(config, field) && "after:ml-0.5 after:text-danger after:content-['*']");
}

/**
 * The Private key box (SF-014). A key is drawn as text only while the box has focus or after Show key, so a pasted
 * key is hidden as soon as it lands, a typed one when the box is left, and a saved one is never drawn when the
 * connection is opened for editing: a screen share or a screenshot of the dialog carries no key. A hidden key is
 * still the form's value, so Test Connection and Save send it unchanged; Replace key empties the box for a new one.
 * Masking the textarea itself is not portable (`-webkit-text-security` is not a standard property), so the text is
 * not drawn at all instead.
 */
function PrivateKeyBox({
  config,
  value,
  onChange,
}: {
  readonly config: ConnectionFormSpec;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const required = isRequired(config, "privateKey");
  const [drawn, setDrawn] = useState(false);
  const [focusOnDraw, setFocusOnDraw] = useState(false);
  if (value !== "" && !drawn) {
    return (
      <div
        data-testid="privateKey-stored"
        className="flex flex-wrap items-center gap-2 rounded-md bg-panel border border-hairline p-3 text-xs text-fg-muted"
      >
        <span className="flex-1 min-w-[12rem]">A private key is entered. It is not shown.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFocusOnDraw(true);
            setDrawn(true);
          }}
        >
          Show key
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onChange("");
            setFocusOnDraw(true);
            setDrawn(true);
          }}
        >
          Replace key
        </Button>
      </div>
    );
  }
  return (
    <textarea
      id="privateKey"
      aria-required={required || undefined}
      value={value}
      // Show key and Replace key hand the focus to the box they draw, so leaving it hides the key again.
      autoFocus={focusOnDraw}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => {
        setDrawn(true);
        setFocusOnDraw(false);
      }}
      onBlur={() => setDrawn(false)}
      // The pasted text lands before this runs, so the key is hidden at once rather than when the box is left.
      onPaste={() => setDrawn(false)}
      placeholder={connectionFieldPlaceholder(config, "privateKey", "")}
      autoComplete="off"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      rows={5}
      aria-describedby={describedByHint(config, "privateKey")}
      className="w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono text-fg p-3"
    />
  );
}

interface ConnectionFieldControlProps {
  readonly config: ConnectionFormSpec;
  readonly field: BodyConnectionField;
  readonly value: string;
  readonly onChange: (field: BodyConnectionField, value: string) => void;
  /** Added to the field's outer box, such as the column span of a row. */
  readonly className?: string;
  /** The credential warning, drawn under the field whose descriptor carries it; a caution that blocks nothing. */
  readonly credentialWarning?: string;
}

/** One connection field, drawn as its descriptor says. */
export function ConnectionFieldControl({
  config,
  field,
  value,
  onChange,
  className,
  credentialWarning,
}: ConnectionFieldControlProps) {
  const descriptor = bodyFieldDescriptor(field);
  const { control } = descriptor;
  const label = connectionFieldLabel(config, field, descriptor.label);
  const placeholder =
    descriptor.placeholder === undefined
      ? undefined
      : connectionFieldPlaceholder(config, field, descriptor.placeholder);
  const change = (next: string) => onChange(field, next);

  if (control.kind === "text" && control.compact === true) {
    return (
      <div className="space-y-1.5">
        <Label className={LABEL_CLASS}>{label}</Label>
        <Input
          value={value}
          onChange={(e) => change(e.target.value)}
          placeholder={placeholder}
          aria-describedby={describedByHint(config, field)}
          className="h-9 bg-panel border-hairline focus:border-hue-orange-tint/50 text-xs"
        />
        <DeclaredFieldHint config={config} field={field} />
      </div>
    );
  }

  const Icon = ICONS[descriptor.icon ?? "key"];
  let box: React.ReactNode;
  if (control.kind === "text") {
    box = (
      <Input
        id={field}
        {...(isRequired(config, field) ? { "aria-required": true as const } : {})}
        {...TYPING_PROPS[control.typing]}
        value={value}
        onChange={(e) => change(e.target.value)}
        placeholder={placeholder}
        {...(control.numeric === true ? { inputMode: "numeric" as const } : {})}
        aria-describedby={describedByHint(config, field)}
        className={cn(BOX_CLASS, control.monospace === true && "font-mono")}
      />
    );
  } else if (control.kind === "select") {
    box = (
      <select
        id={field}
        value={value}
        onChange={(e) => change(e.target.value)}
        aria-describedby={describedByHint(config, field)}
        className="h-10 w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 transition-all text-xs text-fg px-3"
      >
        {control.offerNone && <option value="">None</option>}
        {(config.fieldOptions?.[field] ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (control.kind === "toggle") {
    /*
     * A FIELDSET, AND IT POINTS AT ITS OWN HINT. The buttons are one choice, so the container is the element that
     * groups them - `fieldset` rather than a `div` with `role="group"`, which is the same semantics and what the a11y
     * rule asks for - and because a button group has no `aria-describedby` to inherit, the hint is wired here the way
     * every input in the dialog wires its own.
     */
    box = (
      <fieldset
        id={field}
        aria-label={label}
        aria-describedby={describedByHint(config, field)}
        className="flex flex-wrap gap-1.5 border-0 p-0 m-0"
      >
        {control.choices.map((choice) => {
          const pressed = value === choice || (value === "" && choice === control.unset);
          return (
            <button
              key={choice}
              type="button"
              onClick={() => change(choice)}
              aria-pressed={pressed}
              className={cn(
                "px-2.5 py-1.5 rounded-md text-xs font-medium transition-all border",
                pressed
                  ? "border-hue-emerald-tint/30 bg-hue-emerald-tint/10 text-hue-emerald"
                  : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
              )}
            >
              {choice}
            </button>
          );
        })}
      </fieldset>
    );
  } else if (control.kind === "textarea") {
    box = (
      <textarea
        id={field}
        value={value}
        onChange={(e) => change(e.target.value)}
        placeholder={placeholder}
        {...TYPING_PROPS.verbatim}
        rows={control.rows}
        aria-describedby={describedByHint(config, field)}
        className="w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono text-fg p-3"
      />
    );
  } else {
    box = <PrivateKeyBox config={config} value={value} onChange={change} />;
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2 mb-1">
        <Icon strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
        <Label htmlFor={field} className={labelClass(config, field)}>
          {label}
        </Label>
      </div>
      {box}
      <DeclaredFieldHint config={config} field={field} />
      {descriptor.note !== undefined && config.fieldPlaceholders?.[field] === undefined && (
        <p className="text-xs text-fg-muted">{descriptor.note}</p>
      )}
      {/*
        A credential the engine declares a warning for (src/lib/db/credential-warnings.ts), drawn before Test
        Connection and apart from its result: a caution about what was typed, which blocks nothing. An `output` rather
        than a p with role="status": it carries the polite live region natively, and jsx-a11y's prefer-tag-over-role
        is an error in this repository.
      */}
      {descriptor.carriesCredentialWarning === true && credentialWarning !== undefined && (
        <output
          id="credential-warning"
          data-testid="credential-warning"
          className="flex items-start gap-1.5 text-xs text-warning"
        >
          <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
          <span>{credentialWarning}</span>
        </output>
      )}
    </div>
  );
}

/**
 * A row of fields side by side, a lone field across the whole row, and the group's own note under them. An
 * always-drawn row with none of its fields is drawn empty, so the form keeps the spacing it has always had.
 */
export function ConnectionFieldGroupRow({
  config,
  group,
  fields,
  values,
  onChange,
  credentialWarning,
}: {
  readonly config: ConnectionFormSpec;
  readonly group: ConnectionFieldGroupName;
  readonly fields: readonly BodyConnectionField[];
  readonly values: Readonly<Partial<Record<BodyConnectionField, string>>>;
  readonly onChange: (field: BodyConnectionField, value: string) => void;
  readonly credentialWarning?: string;
}) {
  const { note } = CONNECTION_FIELD_GROUPS[group];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {fields.map((field) => (
        <ConnectionFieldControl
          key={field}
          config={config}
          field={field}
          value={values[field] ?? ""}
          onChange={onChange}
          className={fields.length === 1 ? "md:col-span-2" : undefined}
          credentialWarning={credentialWarning}
        />
      ))}
      {note !== undefined && <p className="text-xs text-fg-muted md:col-span-2">{note}</p>}
    </div>
  );
}
