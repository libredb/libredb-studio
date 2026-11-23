import assert from "node:assert/strict";
import type { RunConfirmationOffer } from "@/lib/api/run-confirmation";
import { askToRun, RUN_ANYWAY, RunNotConfirmedError } from "../../../src/host/editor/run-confirmation";
import { answerInputBoxes, answerMessages, shownInputBoxes, shownMessages, window } from "../../fakes/vscode";

const STATEMENT = "delete from t";

/** An offer as the child answers it, with a token generated for the test. */
function offer(typedConfirmation: RunConfirmationOffer["typedConfirmation"] = null): RunConfirmationOffer {
  return {
    token: crypto.randomUUID(),
    expiresAt: new Date(0).toISOString(),
    unreadable: false,
    typedConfirmation,
    classificationFailed: false,
  };
}

const MODAL = {
  level: "warning",
  message: "This statement may change data, database objects, or permissions. Review it before running it on shop.",
  options: { modal: true, detail: STATEMENT },
  items: [RUN_ANYWAY],
};

describe("the run confirmation prompt (FND-5 6e)", () => {
  it("asks one modal and answers the token for an offer with nothing typed", async () => {
    const asked = offer();
    answerMessages(() => RUN_ANYWAY);
    assert.deepEqual(await askToRun(window, { connectionName: "shop", statement: STATEMENT, offer: asked }), {
      token: asked.token,
    });
    assert.deepEqual(shownMessages, [MODAL]);
    assert.deepEqual(shownInputBoxes, []);
  });

  it("asks the modal, then the input box for a typed ask, and answers the token and the value", async () => {
    const name = crypto.randomUUID();
    const asked = offer({ type: "connection-name", expected: name, targets: [] });
    answerMessages(() => RUN_ANYWAY);
    answerInputBoxes(() => name);
    assert.deepEqual(await askToRun(window, { connectionName: name, statement: STATEMENT, offer: asked }), {
      token: asked.token,
      typed: name,
    });
    assert.equal(shownMessages.length, 1);
    assert.equal(shownInputBoxes.length, 1);
    const [box] = shownInputBoxes;
    assert.equal(box.ignoreFocusOut, true);
    assert.equal(box.prompt, `Type the connection's name, ${name}, to run this statement.`);
  });

  it("asks for a row's text by itself", async () => {
    const lease = "694d77aa9e38260f";
    answerMessages(() => RUN_ANYWAY);
    answerInputBoxes(() => lease);
    const asked = offer({ type: "text", expected: lease });
    assert.deepEqual(await askToRun(window, { connectionName: "shop", statement: STATEMENT, offer: asked }), {
      token: asked.token,
      typed: lease,
    });
    assert.equal(shownInputBoxes[0].prompt, `Type ${lease} to run this statement.`);
  });

  it("the input box refuses any value but the expected one", async () => {
    const name = crypto.randomUUID();
    answerMessages(() => RUN_ANYWAY);
    await askToRun(window, {
      connectionName: name,
      statement: STATEMENT,
      offer: offer({ type: "connection-name", expected: name, targets: [] }),
    });
    const validate = shownInputBoxes[0].validateInput;
    assert.ok(validate !== undefined);
    const refusal = `Type ${name} exactly.`;
    assert.equal(validate(""), refusal);
    assert.equal(validate(name.toUpperCase()), refusal);
    assert.equal(validate(` ${name}`), refusal);
    assert.equal(validate(name), undefined);
  });

  it("names a name ask's targets", async () => {
    const name = crypto.randomUUID();
    answerMessages(() => RUN_ANYWAY);
    await askToRun(window, {
      connectionName: name,
      statement: STATEMENT,
      offer: offer({ type: "connection-name", expected: name, targets: ["orders", "every key"] }),
    });
    assert.equal(
      shownInputBoxes[0].prompt,
      `Type the connection's name, ${name}, to run this statement. It reaches orders, every key.`,
    );
  });

  it("answers undefined when the modal or the input box is dismissed", async () => {
    const name = crypto.randomUUID();
    const typedAsk = offer({ type: "connection-name", expected: name, targets: [] });
    // The modal dismissed: no input box.
    assert.equal(await askToRun(window, { connectionName: name, statement: STATEMENT, offer: typedAsk }), undefined);
    assert.deepEqual(shownInputBoxes, []);
    // The modal accepted, the input box escaped.
    answerMessages(() => RUN_ANYWAY);
    assert.equal(await askToRun(window, { connectionName: name, statement: STATEMENT, offer: typedAsk }), undefined);
    assert.equal(shownInputBoxes.length, 1);
  });

  it("names a declined confirmation", () => {
    const error = new RunNotConfirmedError();
    assert.equal(error.name, "RunNotConfirmedError");
    assert.equal(error.message, "The statement was not run: its confirmation was declined.");
  });
});
