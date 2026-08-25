import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Written once, so nothing can subscribe to one breakpoint and decide from another. */
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Whether the viewport is below the mobile breakpoint RIGHT NOW.
 *
 * `useIsMobile` is the wrong instrument for a caller that has to DECIDE something at
 * a point in time rather than render from it: the hook subscribes, so what it hands
 * you is the value of the render you are inside, not necessarily the platform's
 * answer at the instant a handler or an effect runs. This asks the platform instead,
 * and answers exactly.
 *
 * It answers false where there is no window, which is the same answer the hook gives
 * on the server, so nothing rendered on the server disagrees with the client's
 * hydration pass. Use the HOOK for anything a render reads: this one does not
 * subscribe, so a viewport that changes afterwards will not re-render anybody.
 *
 * Both read `MOBILE_QUERY`, so the two can never answer about different breakpoints.
 */
export function isMobileViewport(): boolean {
  return typeof window === "undefined" ? false : window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * The media query list is built per mount rather than once per module: it is the
 * object the subscription and the snapshot must agree on, and a module-level cache
 * would outlive the window it was taken from.
 */
function createMobileStore() {
  const mql = typeof window === "undefined" ? null : window.matchMedia(MOBILE_QUERY);
  return {
    subscribe: (onStoreChange: () => void) => {
      mql?.addEventListener("change", onStoreChange);
      return () => mql?.removeEventListener("change", onStoreChange);
    },
    getSnapshot: () => mql?.matches === true,
  };
}

/** There is no viewport on the server, so the server render answers false. */
const getServerSnapshot = () => false;

/**
 * The viewport is an external store, so it is read as one: a component mounted AFTER
 * hydration knows the answer on its very first render instead of seeding false and
 * correcting itself in an effect, which spares it a presentation swap on a narrow
 * viewport.
 *
 * A consumer that is part of the HYDRATION tree gets no such head start: React reads
 * `getServerSnapshot` — false — for the hydrating render so the client agrees with the
 * server markup, and the real viewport only arrives with the store subscription just
 * after commit. On a narrow viewport such a consumer still swaps once on first load.
 */
export function useIsMobile() {
  const [store] = React.useState(createMobileStore);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}
