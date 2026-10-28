/**
 * questions.yaml, the form Rancher's Apps page draws from a chart, for the Rancher-mode values.
 *
 * Rancher sets each answer at the dotted path its `variable` names, so a variable that names no key of values.yaml, or
 * whose type differs from the key's, writes a value the chart then ignores or the schema refuses at install. The form
 * splits a path on dots only, so a list index such as ingress.hosts[0].host cannot be one; no variable here uses one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

interface Question {
  variable: string;
  label: string;
  description: string;
  type: string;
  group: string;
  default?: unknown;
  options?: string[];
  show_if?: string;
  subquestions?: Question[];
  show_subquestion_if?: unknown;
}

const questions = (parse(readFileSync(join(CHART_DIR, "questions.yaml"), "utf8")) as { questions: Question[] })
  .questions;
const values = parse(readFileSync(join(CHART_DIR, "values.yaml"), "utf8")) as Record<string, unknown>;

function flatten(list: Question[]): Question[] {
  return list.flatMap((question) => [question, ...flatten(question.subquestions ?? [])]);
}

const all = flatten(questions);

function lookup(path: string): { found: boolean; value: unknown } {
  let node: unknown = values;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object" || !(part in (node as Record<string, unknown>))) {
      return { found: false, value: undefined };
    }
    node = (node as Record<string, unknown>)[part];
  }
  return { found: true, value: node };
}

/** The question types whose answer is a string. */
const STRING_TYPES = new Set(["string", "enum", "hostname", "password"]);

describe("questions.yaml", () => {
  test("every variable names a key of values.yaml with a dotted path and no list index", () => {
    for (const question of all) {
      expect(question.variable).toMatch(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/);
      expect({ variable: question.variable, found: lookup(question.variable).found }).toEqual({
        variable: question.variable,
        found: true,
      });
    }
  });

  test("each question's type matches its key's default, and a default it states equals values.yaml", () => {
    for (const question of all) {
      const { value } = lookup(question.variable);
      if (question.type === "boolean") expect(value === null || typeof value === "boolean").toBe(true);
      else if (question.type === "int") expect(value === null || typeof value === "number").toBe(true);
      else if (question.type === "array") expect(Array.isArray(value)).toBe(true);
      else {
        expect(STRING_TYPES.has(question.type)).toBe(true);
        expect(typeof value).toBe("string");
      }
      if ("default" in question && value !== null) expect(question.default).toEqual(value);
      expect(question.label.length).toBeGreaterThan(0);
      expect(question.description.length).toBeGreaterThan(0);
      expect(question.group.length).toBeGreaterThan(0);
    }
  });

  test("an enum's options include its key's default and the authProvider values", () => {
    for (const question of all.filter((entry) => entry.type === "enum")) {
      expect(question.options).toContain(lookup(question.variable).value as string);
    }
    expect(all.find((question) => question.variable === "authProvider")?.options).toEqual(["local", "oidc"]);
  });

  test("covers every Rancher-mode value of the chart", () => {
    const variables = new Set(all.map((question) => question.variable));
    for (const variable of [
      "authProvider",
      "config.oidcIssuer",
      "config.oidcScope",
      "config.oidcPrompt",
      "config.oidcAutoRedirect",
      "config.sessionTtlSeconds",
      "secrets.oidcExistingSecret",
      "config.allowCustomConnections",
      "config.seedLiteralValues",
      "seedConnections.enabled",
      "seedConnections.existingSecret",
      "seedConnections.cacheTTL",
      "rancher.navLink.enabled",
      "rancher.navLink.label",
      "rancher.navLink.group",
      "rancher.navLink.target",
      "accessReview.enabled",
      "accessReview.cacheSeconds",
      "accessReview.signIn",
      "discovery.kubernetes.enabled",
      "discovery.kubernetes.namespaces",
      "discovery.kubernetes.intervalMs",
      "discovery.kubernetes.kinds",
      "discovery.kubernetes.maxAgeMs",
      "agent.enabled",
      "mcp.enabled",
    ]) {
      expect({ variable, present: variables.has(variable) }).toEqual({ variable, present: true });
    }
  });

  test("the OIDC scope states no default, since values.yaml's openid profile email is one Rancher refuses", () => {
    const scope = all.find((question) => question.variable === "config.oidcScope");
    expect(scope && "default" in scope).toBe(false);
    expect(scope?.description).toStartWith(
      "Replace the prefilled value: openid profile groups on Rancher 2.15 and later, openid profile before",
    );
  });

  test("the agent question says only true is refused under the access review", () => {
    const agent = all.find((question) => question.variable === "agent.enabled");
    expect(agent?.description).toContain("refuses only true");
  });

  test("never asks for a value the access review refuses or a secret value", () => {
    const variables = all.map((question) => question.variable);
    expect(variables).not.toContain("config.oidcRoleClaim");
    expect(
      variables.some((variable) => variable.startsWith("secrets.") && variable !== "secrets.oidcExistingSecret"),
    ).toBe(false);
    expect(all.some((question) => question.type === "password")).toBe(false);
  });

  test("a show_if names only variables of the form", () => {
    const variables = new Set(all.map((question) => question.variable));
    for (const question of all.filter((entry) => entry.show_if)) {
      for (const clause of (question.show_if as string).split("&&")) {
        expect(variables.has(clause.split("=")[0].trim())).toBe(true);
      }
    }
  });
});
