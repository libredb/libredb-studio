import { afterEach, describe, expect, test } from "bun:test";
import {
  INVALID_RUN_CONFIRMATION_SETTING,
  runConfirmationMode,
  runConfirmationSetting,
} from "@/lib/config/run-confirmation";
import { DatabaseConfigError } from "@/lib/db/errors";

/**
 * LIBREDB_RUN_CONFIRMATION decides who the run routes refuse when a statement needs a confirmation and the request
 * carries none: in `advisory` mode, the default, such a request runs and its answer says it ran unconfirmed; in
 * `required` mode it is answered 428. A value Studio cannot read is refused by name, never read as advisory.
 */
describe("the run confirmation mode (FND-5)", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;

  afterEach(() => {
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
  });

  function setMode(value: string | undefined): void {
    if (value === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = value;
  }

  test.each([undefined, "", "   ", "''", '""'])("unset and empty read advisory (%p)", (value) => {
    setMode(value);
    expect(runConfirmationSetting()).toEqual({ mode: "advisory", source: "default" });
    expect(runConfirmationMode()).toBe("advisory");
  });

  test.each([
    ["advisory", "advisory"],
    [" Advisory ", "advisory"],
    ['"advisory"', "advisory"],
    ["required", "required"],
    ["REQUIRED", "required"],
    ["'required'", "required"],
    ['" required "', "required"],
  ] as const)("advisory and required read as themselves in the accepted spellings (%p)", (value, mode) => {
    setMode(value);
    expect(runConfirmationSetting()).toEqual({ mode, source: "set" });
    expect(runConfirmationMode()).toBe(mode);
  });

  test.each(["true", "off", "require", "advisory,required", "\"required'", "''required''"])(
    "any other value is refused by name, never read as advisory (%p)",
    (value) => {
      setMode(value);
      expect(runConfirmationSetting()).toEqual({ invalid: value });
      expect(() => runConfirmationMode()).toThrow(new DatabaseConfigError(INVALID_RUN_CONFIRMATION_SETTING));
      expect(() => runConfirmationMode()).toThrow(DatabaseConfigError);
    },
  );

  test("the variable is read on every call, so a changed value is answered at once", () => {
    setMode("required");
    expect(runConfirmationMode()).toBe("required");
    setMode(undefined);
    expect(runConfirmationMode()).toBe("advisory");
  });
});
