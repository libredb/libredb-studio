import { resetFake } from "../fakes/vscode";

/** Mocha's root hooks: every test starts from an empty fake host. */
export const mochaHooks = {
  beforeEach(): void {
    resetFake();
  },
};
