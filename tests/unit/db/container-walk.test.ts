import { describe, test, expect } from "bun:test";
import { sessionDefaultContainer } from "@/lib/db/container-walk";
import type { Container } from "@/lib/db/types";

const container = (name: string, isSessionDefault?: boolean): Container => ({
  path: [name],
  name,
  level: 0,
  ...(isSessionDefault === undefined ? {} : { isSessionDefault }),
});

/**
 * The arm the fleet's provider suites never reach (#789). Every engine that marks a session
 * default marks exactly one, so a live walk exercises the one-default and the no-default cases
 * and nothing else: the two-defaults case is a PROVIDER DEFECT, and what this pins is that the
 * shared rule declines rather than picking one.
 */
describe("sessionDefaultContainer", () => {
  test("answers the one container that says it is the session's", () => {
    expect(sessionDefaultContainer([container("app", true), container("sales")])).toEqual(["app"]);
  });

  test("answers nothing when no container says so, which several engines cannot", () => {
    expect(sessionDefaultContainer([container("app"), container("sales")])).toBeUndefined();
  });

  test("answers nothing when TWO containers say so, rather than picking one", () => {
    // A tie-breaker that guesses is worse than one that declines: the consumer's refusal is
    // correct and its guess is not, and two flagged containers is a provider defect rather
    // than a state any engine really has.
    expect(sessionDefaultContainer([container("app", true), container("sales", true)])).toBeUndefined();
  });

  test("an empty level has no default, which is not the same as the root container", () => {
    expect(sessionDefaultContainer([])).toBeUndefined();
  });

  // `isSessionDefault` is optional and a provider that omits it means "not the session's".
  // `=== true` rather than truthiness, so a provider that writes a string cannot flag one.
  test("only a literal true flags a container", () => {
    const claimed = { path: ["app"], name: "app", level: 0, isSessionDefault: "yes" } as unknown as Container;
    expect(sessionDefaultContainer([claimed])).toBeUndefined();
  });
});
