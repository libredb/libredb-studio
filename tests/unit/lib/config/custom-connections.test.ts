import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  CUSTOM_CONNECTIONS_DISABLED_MESSAGE,
  customConnectionsAllowed,
  resetCustomConnectionsWarning,
} from "@/lib/config/custom-connections";
import { logger } from "@/lib/logger";

const original = process.env.ALLOW_CUSTOM_CONNECTIONS;
const originalGovernanceSource = process.env.GOVERNANCE_SOURCE;

beforeEach(() => {
  delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  delete process.env.GOVERNANCE_SOURCE;
  resetCustomConnectionsWarning();
});

afterEach(() => {
  if (original === undefined) delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  else process.env.ALLOW_CUSTOM_CONNECTIONS = original;
  if (originalGovernanceSource === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = originalGovernanceSource;
  resetCustomConnectionsWarning();
});

describe("customConnectionsAllowed", () => {
  test("allows custom connections when the variable is unset, empty or blank", () => {
    expect(customConnectionsAllowed()).toBe(true);
    process.env.ALLOW_CUSTOM_CONNECTIONS = "";
    expect(customConnectionsAllowed()).toBe(true);
    process.env.ALLOW_CUSTOM_CONNECTIONS = "   ";
    expect(customConnectionsAllowed()).toBe(true);
  });

  test.each(["false", "FALSE", " False ", "0", "off", "OFF", "no", " No "])(
    "%s switches custom connections off",
    (value) => {
      process.env.ALLOW_CUSTOM_CONNECTIONS = value;

      expect(customConnectionsAllowed()).toBe(false);
    },
  );

  test.each(["true", "TRUE", "1", "on", "yes", " Yes "])("%s keeps them on without a warning", (value) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.ALLOW_CUSTOM_CONNECTIONS = value;

      expect(customConnectionsAllowed()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test.each([`"false"`, `'off'`, ` "No" `, `" false "`])(
    "%s switches them off once one pair of quotes is stripped",
    (value) => {
      process.env.ALLOW_CUSTOM_CONNECTIONS = value;

      expect(customConnectionsAllowed()).toBe(false);
    },
  );

  test.each([`"true"`, `'1'`, `""`, `''`])("%s keeps them on once one pair of quotes is stripped", (value) => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      process.env.ALLOW_CUSTOM_CONNECTIONS = value;

      expect(customConnectionsAllowed()).toBe(true);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test.each([`"false'`, `""false""`, `"`, "disabled", "flase"])(
    "%s is unrecognised and switches them off, failing closed",
    (value) => {
      const error = spyOn(logger, "error").mockImplementation(() => {});
      try {
        process.env.ALLOW_CUSTOM_CONNECTIONS = value;

        expect(customConnectionsAllowed()).toBe(false);
      } finally {
        error.mockRestore();
      }
    },
  );

  test("an unrecognised value logs one error per process, naming the value and the accepted values", () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      process.env.ALLOW_CUSTOM_CONNECTIONS = "disabled";

      expect(customConnectionsAllowed()).toBe(false);
      expect(customConnectionsAllowed()).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        'Unrecognized ALLOW_CUSTOM_CONNECTIONS value "disabled"; custom connections are switched off. Accepted values: "false", "0", "off" or "no" to switch them off, "true", "1", "on" or "yes" to keep them on',
        undefined,
        { route: "custom-connections" },
      );
    } finally {
      error.mockRestore();
    }
  });

  test("is read on every call, so a changed environment is answered at once", () => {
    expect(customConnectionsAllowed()).toBe(true);
    process.env.ALLOW_CUSTOM_CONNECTIONS = "off";
    expect(customConnectionsAllowed()).toBe(false);
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;
    expect(customConnectionsAllowed()).toBe(true);
  });

  test("names the refusal in the sentence the API contract fixes", () => {
    expect(CUSTOM_CONNECTIONS_DISABLED_MESSAGE).toBe("Custom connections are disabled on this server");
  });
});

/*
  Governance mode serves the connections of the governance source only (docs/GOVERNANCE.md). The boot check refuses
  an ALLOW_CUSTOM_CONNECTIONS that keeps custom connections on, and the switch answers off under governance whatever
  the variable says, so a server whose boot check was bypassed still refuses every connection a request supplies.
*/
describe("customConnectionsAllowed under governance", () => {
  test("governance switches custom connections off when ALLOW_CUSTOM_CONNECTIONS is unset", () => {
    // Control: unset keeps them on without governance.
    expect(customConnectionsAllowed()).toBe(true);

    process.env.GOVERNANCE_SOURCE = "postgres";

    expect(customConnectionsAllowed()).toBe(false);
  });

  test.each(["true", "1", "on", " Yes ", `"true"`])(
    "governance keeps them off when ALLOW_CUSTOM_CONNECTIONS is %p, without logging",
    (value) => {
      const error = spyOn(logger, "error").mockImplementation(() => {});
      try {
        process.env.ALLOW_CUSTOM_CONNECTIONS = value;
        // Control: the value keeps them on without governance.
        expect(customConnectionsAllowed()).toBe(true);

        process.env.GOVERNANCE_SOURCE = "postgres";

        expect(customConnectionsAllowed()).toBe(false);
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    },
  );

  test("an invalid GOVERNANCE_SOURCE counts as on and switches them off, failing closed", () => {
    process.env.GOVERNANCE_SOURCE = "postgress";

    expect(customConnectionsAllowed()).toBe(false);
  });
});
