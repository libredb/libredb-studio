import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Written once, so nothing can subscribe to one breakpoint and decide from another. */
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Whether the viewport is below the mobile breakpoint RIGHT NOW.
 *
 * `useIsMobile` is the wrong instrument for a caller that has to DECIDE something at
 * a point in time rather than render from it: it seeds false and resolves in an
 * effect, so its value is not merely stale on the first commit — it is wrong on a
 * narrow viewport, and a decision taken from it there is taken from an answer the
 * platform never gave. This asks the platform instead, and answers exactly.
 *
 * It answers false where there is no window, which is the same answer the hook's
 * first render gives, so nothing rendered on the server disagrees with the client's
 * first pass. Use the HOOK for anything a render reads: this one does not subscribe,
 * so a viewport that changes afterwards will not re-render anybody.
 *
 * Both read `MOBILE_QUERY`, so the two can never answer about different breakpoints.
 */
export function isMobileViewport(): boolean {
  return typeof window === "undefined" ? false : window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(false);

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      setIsMobile(mql.matches);
    };
    // The same reading `isMobileViewport` makes, taken from the list this effect has
    // to construct anyway rather than by constructing a second one.
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
