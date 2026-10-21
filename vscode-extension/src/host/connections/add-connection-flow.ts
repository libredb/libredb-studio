// The add-connection flow as a pure state machine (part 2, "The add-connection flow", "Steps", "Connection strings",
// "What the rules produce for the four v0 engines", "Review" and "Test"): it turns the engine catalogue, the person's
// answers and the backend's replies into the next step, and imports no vscode, so add-connection-ui.ts only renders what
// it answers. Every per-engine fact comes from the catalogue; no code here compares a type id with a literal.
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";
import type { ParsedConnection } from "@/lib/connection-string-parser";
import type { ConnectionField } from "@/lib/db/connection-fields";
import type { SSLMode } from "@/lib/types";
import type {
  EngineCatalog,
  EngineField,
  EngineForm,
  PastedConnection,
  TestConnectionResult,
  WireConnection,
} from "../../protocol";
import { FIELD_PROMPTS, FORM_DEFAULTS, fieldLabel, isMaskedField } from "./field-prompts";
import { type ProfileEntry, toEntry } from "./profile";

export interface FlowInit {
  readonly catalog: EngineCatalog;
  /** Minted by the adapter, never equal to a listed id. */
  readonly id: string;
  /** The name of every listed item that has one. */
  readonly savedNames: readonly string[];
  /** createdAt of the tested connection and of the saved entry. */
  now(): Date;
}

export interface FlowItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly separator?: true;
}

export type FlowStep =
  | {
      readonly kind: "pick";
      readonly title: string;
      readonly step?: number;
      readonly totalSteps?: number;
      readonly placeholder?: string;
      readonly items: readonly FlowItem[];
      readonly back: boolean;
      readonly moreOptions: boolean;
    }
  | {
      readonly kind: "input";
      readonly title: string;
      readonly step?: number;
      readonly totalSteps?: number;
      readonly prompt?: string;
      readonly placeholder?: string;
      readonly value: string;
      readonly password: boolean;
      readonly validationMessage?: string;
      readonly back: boolean;
      readonly moreOptions: boolean;
    }
  | { readonly kind: "parse"; readonly text: string }
  | {
      readonly kind: "test";
      readonly title: string;
      readonly step: number;
      readonly totalSteps: number;
      readonly placeholder: string;
      readonly connection: WireConnection;
    }
  | {
      readonly kind: "dialog";
      readonly severity: "warning" | "error";
      readonly message: string;
      readonly detail?: string;
      readonly buttons: readonly string[];
    }
  | { readonly kind: "save"; readonly entry: ProfileEntry; readonly secrets: Readonly<Record<string, string>> };

export type TestOutcome =
  | { readonly kind: "answered"; readonly answer: TestConnectionResult }
  | { readonly kind: "failed"; readonly message: string; readonly fixStatement?: string };

export type FlowInput =
  | { readonly kind: "pick"; readonly id: string }
  | { readonly kind: "accept"; readonly value: string }
  | { readonly kind: "back" }
  /** value is what the box on screen holds, which More Options keeps as Enter would; a pick sends none. */
  | { readonly kind: "moreOptions"; readonly value?: string }
  | { readonly kind: "parsed"; readonly answer: PastedConnection }
  | { readonly kind: "tested"; readonly outcome: TestOutcome }
  | { readonly kind: "dialog"; readonly choice: string | undefined };

export const PORT_REFUSAL = "Enter a port from 1 to 65535, or leave it empty.";
export const NAME_BLANK = "Enter a name for this connection.";
export const UNREADABLE_PASTE = `LibreDB could not read this connection string. Supported formats: ${PASTE_FORMATS_TEXT}`;

export function nameTaken(name: string): string {
  return `A connection named ${name} already exists.`;
}

export function notOffered(label: string): string {
  return `${label} is not available in LibreDB Studio for VS Code.`;
}

/** The tooltip of the $(settings-gear) button that opens Review. */
export const MORE_OPTIONS_TOOLTIP = "SSL and optional fields";
export const SAVE_ANYWAY = "Save Anyway";
export const BACK_TO_REVIEW = "Back to Review";
export const TEST_AGAIN = "Test Again";

/**
 * The four paste cautions in this flow's own words (part 2 "Connection strings"), in this order; the web sentences name
 * dialog controls this flow does not have. sslMode is the draft's SSL mode after the paste.
 */
export function pasteCautions(parsed: ParsedConnection, sslMode: SSLMode): string[] {
  const cautions: string[] = [];
  if (parsed.unmappedTLSParam !== undefined) {
    cautions.push(
      `TLS setting not applied: ${parsed.unmappedTLSParam} has no equivalent among the SSL modes. SSL mode stays ${sslMode}; change it in SSL mode before testing.`,
    );
  }
  if (parsed.credentialsAmbiguous === true) {
    cautions.push(
      "User and password could not be read: the string holds more than one unescaped @. Percent-encode it as %40 and paste it again.",
    );
  }
  if (parsed.tlsFileParam !== undefined) {
    cautions.push(
      `${parsed.tlsFileParam} names a file, which is read on the machine running the extension when it connects.`,
    );
  }
  if (parsed.unsupportedServerProtocol !== undefined) {
    cautions.push(
      `Server not applied: ${parsed.unsupportedServerProtocol}: is a SQL Server protocol this connection cannot use, because it connects over TCP only.`,
    );
  }
  return cautions;
}

type PickStep = Extract<FlowStep, { kind: "pick" }>;
type InputStep = Extract<FlowStep, { kind: "input" }>;
type DialogStep = Extract<FlowStep, { kind: "dialog" }>;

/** Where the flow is; each step is rebuilt from it and the draft, so Back shows what was accepted there. */
type Position =
  | { readonly at: "engine" | "method" | "test" | "name" | "review" | "ssl" | "save" }
  | { readonly at: "field"; readonly index: number }
  /** A paste box or its parse; one opened from Review returns to it. */
  | { readonly at: "paste" | "parse"; readonly fromReview: boolean }
  /** A field's box opened from Review. */
  | { readonly at: "edit"; readonly field: EngineField }
  /** answer is the pass a warning dialog shows, which Save Anyway names. */
  | { readonly at: "dialog"; readonly answer?: TestConnectionResult };

/** The fields a kept pasted string stands for, which the web rule clears (handlePasteConnectionString). */
const PASTE_CLEARS: ReadonlySet<ConnectionField> = new Set(["host", "port", "user", "password"]);
/** Written even when empty, as buildConnection writes every addressed field; a port is not (builder's call 2). */
const ALWAYS_WRITTEN: ReadonlySet<ConnectionField> = new Set(["host", "user", "database"]);
const PORT = /^\d{1,5}$/;
/** The modes v0 offers: it takes no certificate, which verify-ca and verify-full exist to pin (SSLMode docblock). */
const SSL_CHOICES: readonly (FlowItem & { readonly id: SSLMode })[] = [
  { id: "disable", label: "disable", description: "No TLS" },
  { id: "require", label: "require", description: "Encrypt, verify nothing" },
  {
    id: "verify-system",
    label: "verify-system",
    description: "Encrypt, and verify against the system's trusted roots",
  },
];

export class AddConnectionFlow {
  private shown: FlowStep;
  private position: Position = { at: "engine" };
  /** Set by the engine step before any later step reads it. */
  private engine!: EngineForm;
  private draft = new Map<ConnectionField, string>();
  private sslMode: SSLMode = FORM_DEFAULTS.sslMode;
  /** The pasted text, verbatim, while the draft keeps it as the connection string; undefined otherwise. */
  private kept: string | undefined;
  /** Details until the method step is answered with a paste. */
  private method: "paste" | "details" = "details";
  /** The cautions of the paste the draft took, which Review lists. */
  private cautions: string[] = [];
  /** The linear step More Options opened Review from, which Review's Back shows again (builder's call 7). */
  private reviewBack: (() => FlowStep) | undefined;
  /** The name typed at Name before More Options, which the next Name shows in place of the suggestion. */
  private named: string | undefined;

  constructor(private readonly init: FlowInit) {
    this.shown = this.engineStep();
  }

  get step(): FlowStep {
    return this.shown;
  }

  /** The sentence the current input step shows for a value while the person types, or undefined. */
  validate(value: string): string | undefined {
    const { position } = this;
    const field =
      position.at === "field" ? this.linear[position.index] : position.at === "edit" ? position.field : undefined;
    if (field !== undefined) {
      return FIELD_PROMPTS[field.name].input === "port" && !isPort(value) ? PORT_REFUSAL : undefined;
    }
    if (position.at !== "name") return undefined;
    const name = value.trim();
    if (name === "") return NAME_BLANK;
    return this.isSaved(name) ? nameTaken(name) : undefined;
  }

  /**
   * Moves on from the current step. An accepted value its check refuses answers the same step with the sentence; an
   * input of the wrong kind, or a pick id the step does not offer, throws.
   */
  advance(input: FlowInput): FlowStep {
    switch (input.kind) {
      case "pick":
        this.expect(input, "pick");
        return this.show(this.picked(input.id));
      case "accept":
        this.expect(input, "input");
        return this.show(this.accepted(input.value));
      case "back":
        this.expect(input, "pick", "input");
        return this.show(this.back());
      case "moreOptions":
        this.expect(input, "pick", "input");
        return this.show(this.moreOptions(input.value));
      case "parsed":
        this.expect(input, "parse");
        return this.show(this.read(input.answer));
      case "tested":
        this.expect(input, "test");
        return this.show(this.tested(input.outcome));
      case "dialog":
        this.expect(input, "dialog");
        return this.show(this.chose(input.choice));
    }
  }

  private show(step: FlowStep): FlowStep {
    this.shown = step;
    return step;
  }

  private expect(input: FlowInput, ...kinds: FlowStep["kind"][]): void {
    if (!kinds.includes(this.shown.kind)) throw this.outOfTurn(input);
  }

  private outOfTurn(input: FlowInput): Error {
    return new Error(`${input.kind} does not answer ${stepOfKind(this.shown.kind)}`);
  }

  private picked(id: string): FlowStep {
    if (!(this.shown as PickStep).items.some((item) => item.id === id && item.separator !== true)) {
      throw new Error(`"${id}" is not an item of this step`);
    }
    if (this.position.at === "review") return this.reviewed(id);
    if (this.position.at === "ssl") {
      this.sslMode = id as SSLMode;
      return this.reviewStep();
    }
    if (this.position.at === "engine") {
      const engine = this.init.catalog.engines.find((each) => each.type === id) as EngineForm;
      // Another engine starts a new draft (SF-002); the same one keeps what was typed for it.
      if (engine !== this.engine) this.start(engine);
      if (this.engine.pasteScheme !== null) return this.methodStep();
      this.method = "details";
      return this.fieldOrTest(0);
    }
    this.method = id === "paste" ? "paste" : "details";
    return this.method === "paste" ? this.pasteStep("", false) : this.fieldOrTest(0);
  }

  /** Review's items: Test and Continue tests; a field, the kept string and SSL mode open their input; a caution stays. */
  private reviewed(id: string): FlowStep {
    if (id === "test") return this.testStep();
    if (id === "ssl") return this.sslStep();
    // Listed only while the draft keeps a pasted string.
    if (id === "connectionString") return this.pasteStep(this.kept as string, true);
    const field = this.engine.fields.find((each) => `field:${each.name}` === id);
    return field === undefined ? this.reviewStep() : this.editStep(field);
  }

  private accepted(value: string): FlowStep {
    const refusal = this.validate(value);
    if (refusal !== undefined) return { ...(this.shown as InputStep), value, validationMessage: refusal };
    const { position } = this;
    if (position.at === "field") {
      this.draft.set(this.linear[position.index].name, value);
      return this.fieldOrTest(position.index + 1);
    }
    if (position.at === "edit") {
      this.draft.set(position.field.name, value);
      return this.reviewStep();
    }
    if (position.at === "paste") {
      this.position = { at: "parse", fromReview: position.fromReview };
      return { kind: "parse", text: value };
    }
    this.position = { at: "save" };
    return { kind: "save", ...toEntry(this.wire(value.trim())) };
  }

  /**
   * A field goes to the one before it, the first field to the method (or the engine), the paste box to the method, the
   * method to the engine; Review to the step More Options opened it from; Name and what Review opened, to Review.
   */
  private back(): FlowStep {
    if (!(this.shown as PickStep | InputStep).back) throw new Error("back does not answer a step without Back");
    const { position } = this;
    switch (position.at) {
      case "review": {
        // Shown only while Review has a step to return to.
        const back = this.reviewBack as () => FlowStep;
        this.reviewBack = undefined;
        return back();
      }
      case "field":
        if (position.index > 0) return this.fieldOrTest(position.index - 1);
        return this.engine.pasteScheme === null ? this.engineStep() : this.methodStep();
      case "paste":
        return position.fromReview ? this.reviewStep() : this.methodStep();
      case "method":
        return this.engineStep();
      default:
        return this.reviewStep();
    }
  }

  /**
   * Review, with a Back to the linear step it was opened from; opened from Name, after a test, it has none. The value the
   * box holds is kept as Enter keeps it, and one Enter would refuse answers the same step with the sentence; the paste
   * box's text is kept for Back, unread until Enter, and a name for the Name after the next test.
   */
  private moreOptions(value: string | undefined): FlowStep {
    const shown = this.shown as PickStep | InputStep;
    if (!shown.moreOptions) throw new Error("moreOptions does not answer a step without More Options");
    if (value !== undefined && shown.kind === "pick") {
      throw new Error("moreOptions carries a value only from an input step");
    }
    const refusal = value === undefined ? undefined : this.validate(value);
    if (refusal !== undefined) return { ...(shown as InputStep), value: value as string, validationMessage: refusal };
    const { position } = this;
    if (position.at === "method") this.reviewBack = () => this.methodStep();
    if (position.at === "field") {
      if (value !== undefined) this.draft.set(this.linear[position.index].name, value);
      this.reviewBack = () => this.fieldOrTest(position.index);
    }
    if (position.at === "paste") {
      const text = value ?? (shown as InputStep).value;
      this.reviewBack = () => this.pasteStep(text, false);
    }
    if (position.at === "name" && value !== undefined) this.named = value.trim();
    return this.reviewStep();
  }

  /** The child's reading of the pasted text, in the order part 2 "Connection strings" decides it. */
  private read({ parsed, label }: PastedConnection): FlowStep {
    const text = (this.shown as Extract<FlowStep, { kind: "parse" }>).text;
    const { fromReview } = this.position as Extract<Position, { at: "parse" }>;
    if (parsed === null) return this.pasteStep(text, fromReview, UNREADABLE_PASTE);
    if (parsed.refusal !== undefined) {
      return this.pasteStep(parsed.discardPaste ? "" : text, fromReview, parsed.refusal);
    }
    const engine = this.init.catalog.engines.find((each) => each.type === parsed.type);
    if (engine === undefined) return this.pasteStep(text, fromReview, notOffered(label ?? parsed.type));
    // The web rule: a paste for another engine starts from an empty draft (handlePasteConnectionString, SF-002).
    if (engine !== this.engine) this.start(engine);
    this.take(parsed, text);
    // A caution is read before any test; a paste opened from Review returns to it.
    return fromReview || this.cautions.length > 0 ? this.reviewStep() : this.testStep();
  }

  /** A plain pass names the connection; a pass with a caution, or a failure, asks in a modal dialog first. */
  private tested(outcome: TestOutcome): FlowStep {
    if (outcome.kind === "failed") {
      return this.dialogStep({
        severity: "error",
        message: outcome.message,
        ...(outcome.fixStatement === undefined ? {} : { detail: outcome.fixStatement }),
        buttons: [TEST_AGAIN, BACK_TO_REVIEW],
      });
    }
    const { answer } = outcome;
    const warnings = answer.warnings ?? [];
    if (!("degraded" in answer) && warnings.length === 0) return this.nameStep(answer);
    return this.dialogStep(
      {
        severity: "warning",
        message: answer.message,
        ...(warnings.length === 0 ? {} : { detail: warnings.map((each) => each.message).join("\n") }),
        buttons: [SAVE_ANYWAY, BACK_TO_REVIEW],
      },
      answer,
    );
  }

  /** Save Anyway names the connection, Test Again tests the same draft; Back to Review, or Escape, gives Review. */
  private chose(choice: string | undefined): FlowStep {
    if (choice !== undefined && !(this.shown as DialogStep).buttons.includes(choice)) {
      throw new Error(`"${choice}" is not a button of this dialog`);
    }
    if (choice === SAVE_ANYWAY) {
      return this.nameStep((this.position as Extract<Position, { at: "dialog" }>).answer as TestConnectionResult);
    }
    return choice === TEST_AGAIN ? this.testStep() : this.reviewStep();
  }

  /** A new draft for the engine: its default host and port where it has them, every other value empty. */
  private start(engine: EngineForm): void {
    this.engine = engine;
    this.draft = new Map();
    if (this.has("host")) this.draft.set("host", engine.defaultHost ?? FORM_DEFAULTS.host);
    if (this.has("port")) this.draft.set("port", engine.defaultPort);
    this.sslMode = FORM_DEFAULTS.sslMode;
    this.kept = undefined;
    this.cautions = [];
  }

  /** The draft takes the reading: the text itself where the engine keeps a pasted string, else the fields it names. */
  private take(parsed: ParsedConnection, text: string): void {
    this.kept = this.engine.keepsPastedString && parsed.connectionString ? text : undefined;
    // The four a kept string clears are the address fields a reading otherwise gives.
    const reading: Partial<Record<ConnectionField, string | undefined>> =
      this.kept === undefined
        ? {
            host: parsed.host,
            port: parsed.port || this.engine.defaultPort,
            user: parsed.user,
            password: parsed.password,
          }
        : {};
    for (const name of PASTE_CLEARS) if (this.has(name)) this.draft.set(name, reading[name] ?? "");
    if (this.has("database")) this.draft.set("database", parsed.database ?? "");
    if (parsed.sslMode !== undefined) this.sslMode = parsed.sslMode;
    this.cautions = pasteCautions(parsed, this.sslMode);
  }

  private has(name: ConnectionField): boolean {
    return this.engine.fields.some((each) => each.name === name);
  }

  private value(name: ConnectionField): string {
    return this.draft.get(name) ?? "";
  }

  /** The engine's fields in order, minus the advanced ones and those FIELD_PROMPTS never asks in a box. */
  private get linear(): EngineField[] {
    return this.engine.fields.filter(
      (each) => each.placement !== "advanced" && FIELD_PROMPTS[each.name].input !== "none",
    );
  }

  /** The fields Review lists: the linear ones, then the advanced ones a box can ask. */
  private get reviewFields(): EngineField[] {
    const advanced = this.engine.fields.filter(
      (each) => each.placement === "advanced" && FIELD_PROMPTS[each.name].input !== "none",
    );
    return [...this.linear, ...advanced];
  }

  /** Engine, method where there is a paste scheme, the paste or each linear field, then test and name. */
  private get total(): number {
    const method = this.engine.pasteScheme === null ? 0 : 1;
    return 1 + method + (this.method === "paste" ? 1 : this.linear.length) + 2;
  }

  /** "Add <label> Connection", and ": <what>" for a step that asks one thing. */
  private title(what?: string): string {
    return `Add ${this.engine.label} Connection${what === undefined ? "" : `: ${what}`}`;
  }

  private isSaved(name: string): boolean {
    const wanted = name.toLowerCase();
    return this.init.savedNames.some((saved) => saved.trim().toLowerCase() === wanted);
  }

  /** The database, else the host, else the engine label, made unique with " (2)", " (3)", ... */
  private suggestedName(): string {
    const base = (this.value("database").trim() || this.value("host").trim() || this.engine.label).trim();
    let name = base;
    for (let n = 2; this.isSaved(name); n += 1) name = `${base} (${n})`;
    return name;
  }

  private engineStep(): FlowStep {
    this.position = { at: "engine" };
    return {
      kind: "pick",
      title: "Add Connection",
      step: 1,
      placeholder: "Choose a database engine",
      items: this.init.catalog.engines.map(({ type, label }) => ({ id: type, label })),
      back: false,
      moreOptions: false,
    };
  }

  private methodStep(): FlowStep {
    this.position = { at: "method" };
    // Details are assumed until the method is chosen.
    this.method = "details";
    return {
      kind: "pick",
      title: this.title(),
      step: 2,
      totalSteps: this.total,
      placeholder: "Choose how to enter the connection",
      items: [
        { id: "paste", label: "Paste a connection string" },
        {
          id: "details",
          label: "Enter connection details",
          detail: this.linear.map((each) => fieldLabel(each)).join(", "),
        },
      ],
      back: true,
      moreOptions: true,
    };
  }

  /** The linear field at index, or the test after the last one. */
  private fieldOrTest(index: number): FlowStep {
    const field = this.linear[index];
    if (field === undefined) return this.testStep();
    this.position = { at: "field", index };
    const first = this.engine.pasteScheme === null ? 2 : 3;
    return { ...this.box(field), step: first + index, totalSteps: this.total, moreOptions: true };
  }

  /** A field's box opened from Review: no numbers, and Back or Enter returns to Review. */
  private editStep(field: EngineField): FlowStep {
    this.position = { at: "edit", field };
    return this.box(field);
  }

  private box(field: EngineField): InputStep {
    return {
      kind: "input",
      title: this.title(fieldLabel(field)),
      ...(field.hint === null ? {} : { prompt: field.hint }),
      ...(field.placeholder === null ? {} : { placeholder: field.placeholder }),
      value: this.value(field.name),
      password: isMaskedField(field.name),
      back: true,
      moreOptions: false,
    };
  }

  /** The paste box: step 3 of the linear path, or opened from Review with no numbers and no More Options. */
  private pasteStep(value: string, fromReview: boolean, validationMessage?: string): FlowStep {
    this.position = { at: "paste", fromReview };
    const declared = this.engine.fields.find((each) => each.name === "connectionString")?.placeholder;
    return {
      kind: "input",
      title: this.title(FIELD_PROMPTS.connectionString.label),
      ...(fromReview ? {} : { step: 3, totalSteps: this.total }),
      placeholder: declared ?? `${this.engine.pasteScheme}://...`,
      value,
      password: true,
      ...(validationMessage === undefined ? {} : { validationMessage }),
      back: true,
      moreOptions: !fromReview,
    };
  }

  /** Rebuilt from the draft each time it shows; a masked field is described as set or not set, never by its value. */
  private reviewStep(): FlowStep {
    this.position = { at: "review" };
    const fields = this.reviewFields;
    // A kept string stands where the first of the four it clears stood, and none of them is listed.
    const stands = this.kept === undefined ? undefined : fields.find((each) => PASTE_CLEARS.has(each.name));
    const items: FlowItem[] = [{ id: "test", label: "Test and Continue" }, separator(0, "")];
    for (const field of fields) {
      if (field === stands) items.push({ id: "connectionString", label: "Connection string", description: "set" });
      if (stands === undefined || !PASTE_CLEARS.has(field.name)) items.push(this.fieldItem(field));
    }
    if (this.engine.offersSsl) items.push({ id: "ssl", label: "SSL mode", description: this.sslMode });
    if (this.cautions.length > 0) {
      items.push(
        separator(1, "Check before testing"),
        ...this.cautions.map((label, n) => ({ id: `caution:${n}`, label })),
      );
    }
    return {
      kind: "pick",
      title: this.title("Review"),
      placeholder: "Change a value, or test the connection",
      items,
      back: this.reviewBack !== undefined,
      moreOptions: false,
    };
  }

  private fieldItem(field: EngineField): FlowItem {
    const value = this.value(field.name);
    const masked = value === "" ? "not set" : "set";
    return {
      id: `field:${field.name}`,
      label: field.placement === "advanced" ? `${fieldLabel(field)} (optional)` : fieldLabel(field),
      description: isMaskedField(field.name) ? masked : value,
    };
  }

  /** The three modes, and the draft's own where a paste set one v0 does not offer. */
  private sslStep(): FlowStep {
    this.position = { at: "ssl" };
    const pasted = SSL_CHOICES.some((each) => each.id === this.sslMode)
      ? []
      : [{ id: this.sslMode, label: this.sslMode, description: "Set by the pasted string" }];
    return {
      kind: "pick",
      title: this.title("SSL mode"),
      items: [...SSL_CHOICES, ...pasted],
      back: true,
      moreOptions: false,
    };
  }

  private dialogStep(step: Omit<DialogStep, "kind">, answer?: TestConnectionResult): FlowStep {
    this.position = { at: "dialog", answer };
    return { kind: "dialog", ...step };
  }

  private testStep(): FlowStep {
    this.position = { at: "test" };
    // Review after a test has no step to return to.
    this.reviewBack = undefined;
    const total = this.total;
    return {
      kind: "test",
      title: this.title(),
      step: total - 1,
      totalSteps: total,
      placeholder: `Testing ${this.engine.label} connection`,
      connection: this.wire(this.suggestedName()),
    };
  }

  private nameStep(answer: TestConnectionResult): FlowStep {
    this.position = { at: "name" };
    const total = this.total;
    return {
      kind: "input",
      title: this.title(),
      step: total,
      totalSteps: total,
      prompt:
        "latency" in answer ? `Connected in ${answer.latency} ms. Name this connection.` : "Name this connection.",
      value: this.named ?? this.suggestedName(),
      password: false,
      back: true,
      moreOptions: true,
    };
  }

  /** The writing rule, for the test and the save: the draft as connection/test and the setting take it. */
  private wire(name: string): WireConnection {
    const connection: Record<string, unknown> = {
      id: this.init.id,
      name,
      type: this.engine.type,
      createdAt: this.init.now().toISOString(),
    };
    for (const { name: field } of this.engine.fields) {
      const { input } = FIELD_PROMPTS[field];
      const value = this.value(field);
      // A none field is never written; a kept string stands for the four it clears.
      if (input === "none" || (this.kept !== undefined && PASTE_CLEARS.has(field))) continue;
      if (input === "port") {
        if (value !== "") connection[field] = Number(value);
      } else if (ALWAYS_WRITTEN.has(field) || value !== "") {
        connection[field] = value;
      }
    }
    if (this.kept !== undefined) connection.connectionString = this.kept;
    if (this.engine.offersSsl && this.sslMode !== "disable") connection.ssl = { mode: this.sslMode };
    return connection as unknown as WireConnection;
  }
}

/** A separator item; n keeps its id apart from the other separator's. */
function separator(n: number, label: string): FlowItem {
  return { id: `separator:${n}`, label, separator: true };
}

function isPort(value: string): boolean {
  return value === "" || (PORT.test(value) && Number(value) >= 1 && Number(value) <= 65535);
}

/** "a pick step", "an input step". */
function stepOfKind(kind: FlowStep["kind"]): string {
  return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} step`;
}
