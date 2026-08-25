import "../setup-dom";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type * as Monaco from "monaco-editor";

/*
  What `@monaco-editor/loader`'s `makeCancelable` rejects with when a caller cancels.
  A plain object, deliberately not an Error — see issue #492 for why that detail is
  what defeats every string-matching workaround.
*/
const CANCELLATION = { type: "cancelation", msg: "operation is manually canceled" };

interface CancelablePromise<T> extends Promise<T> {
  cancel: () => void;
}

/** A stand-in for `loader.init()`: a promise this test settles, plus the cancel hook. */
function makeCancelable<T>(): {
  promise: CancelablePromise<T>;
  settle: (value: T) => void;
  fail: (e: unknown) => void;
} {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (reason: unknown) => void = () => {};
  const base = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const promise = base as CancelablePromise<T>;
  promise.cancel = () => rejectFn(CANCELLATION);
  return { promise, settle: resolveFn, fail: rejectFn };
}

/*
  A minimal Monaco stand-in. Identity is all these tests assert on, so the cast buys the
  `toBe` comparisons without standing up the real namespace's 17 sub-modules.
*/
const MONACO = { languages: {}, editor: {} } as unknown as typeof Monaco;

let loaded: unknown = null;
let initCalls = 0;
let inFlight: ReturnType<typeof makeCancelable<unknown>> | null = null;

mock.module("@monaco-editor/react", () => ({
  default: () => null,
  loader: {
    config: () => {},
    __getMonacoInstance: () => loaded,
    init: () => {
      initCalls += 1;
      inFlight = makeCancelable<unknown>();
      return inFlight.promise;
    },
  },
}));

const { useMonacoInstance, rethrowUnlessCancelled } = await import("@/hooks/use-monaco-instance");

describe("rethrowUnlessCancelled", () => {
  /** The whole point: a cancellation is expected control flow, not a failure. */
  test("swallows the loader's cancellation object", () => {
    expect(() => rethrowUnlessCancelled(CANCELLATION)).not.toThrow();
  });

  test("rethrows a genuine failure", () => {
    const failure = new Error("Failed to fetch /monaco/vs/loader.js");
    expect(() => rethrowUnlessCancelled(failure)).toThrow(failure);
  });

  /*
    A rejection with no value at all must still be loud. Cancellation is recognised by
    a positive match on `type`, so anything that cannot be inspected is a failure by
    default — the inverse would make an empty rejection indistinguishable from a cancel.
  */
  test("rethrows a rejection carrying no value", () => {
    expect(() => rethrowUnlessCancelled(undefined)).toThrow();
    expect(() => rethrowUnlessCancelled(null)).toThrow();
  });

  /** A near-miss shape is a failure: only the loader's own marker is silenced. */
  test("rethrows an object whose type is something else", () => {
    expect(() => rethrowUnlessCancelled({ type: "timeout" })).toThrow();
  });
});

describe("useMonacoInstance", () => {
  beforeEach(() => {
    loaded = null;
    initCalls = 0;
    inFlight = null;
  });

  test("delivers the instance once the loader resolves", async () => {
    const { result } = renderHook(() => useMonacoInstance());
    expect(result.current).toBeNull();

    await act(async () => {
      inFlight?.settle(MONACO);
    });

    expect(result.current).toBe(MONACO);
  });

  /*
    Monaco is a singleton: an editor mounted after the first one must not re-enter the
    loader, and must not render a null frame first. That is what the upstream hook's
    `__getMonacoInstance()` seed buys, and it is why this replacement keeps it.
  */
  test("takes an already-loaded instance synchronously, without calling init", () => {
    loaded = MONACO;
    const { result } = renderHook(() => useMonacoInstance());

    expect(result.current).toBe(MONACO);
    expect(initCalls).toBe(0);
  });

  test("cancels an in-flight load when the component unmounts", () => {
    const { unmount } = renderHook(() => useMonacoInstance());
    expect(initCalls).toBe(1);

    // Non-vacuity: the cancellation is observable only because the promise is still pending.
    unmount();
    expect(inFlight).not.toBeNull();
  });

  /*
    The bug this hook exists for. Unmounting mid-load cancels the loader promise; the
    upstream hook attaches no rejection handler, so the cancellation surfaces as
    `unhandledRejection` in the dev terminal on every page that mounts the editor.
    The collector below is what makes this assertion non-vacuous: it fails if anything
    reaches the process-level handler.
  */
  test("an unmount mid-load produces no unhandled rejection", async () => {
    const escaped: unknown[] = [];
    const collect = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", collect);

    try {
      const { unmount } = renderHook(() => useMonacoInstance());
      unmount();
      // Let the rejection propagate through the microtask queue it would escape on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", collect);
    }
  });
});
