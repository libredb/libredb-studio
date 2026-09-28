import "../../setup-dom";
import "../../helpers/mock-sonner";

import { describe, expect, test } from "bun:test";

import { Sidebar } from "@/components/sidebar";
import { ConnectionsList } from "@/components/sidebar/ConnectionsList";
import { SchemaExplorer } from "@/components/schema-explorer";
import { AgentRail } from "@/components/agent/AgentRail";
import { AnswerCard } from "@/components/agent/AnswerCard";
import { BottomPanel } from "@/components/studio/BottomPanel";
import { QueryToolbar } from "@/components/studio/QueryToolbar";
import { StudioDesktopHeader } from "@/components/studio/StudioDesktopHeader";
import { StudioMobileHeader } from "@/components/studio/StudioMobileHeader";
import { StudioTabBar } from "@/components/studio/StudioTabBar";

/**
 * X5: `Studio.tsx` re-renders its whole tree on every keystroke.
 *
 * The fix memoizes the shell's children and stabilizes the callbacks it hands them,
 * so a keystroke that only changes the editor's text no longer re-commits the rest of
 * the tree. This file pins the STRUCTURAL half of that fix: each child must be wrapped
 * in `React.memo`, because a plain function component re-renders on every parent render
 * no matter how stable its props are. `React.memo` marks the component with
 * `Symbol.for("react.memo")` — the same marker React itself reads to decide a bail-out —
 * so this is the state that makes the optimisation real, not a symptom of one.
 *
 * The behavioural half, that a keystroke hands the sidebar, the agent rail and the
 * toolbar the props they already had, is pinned in `tests/components/Studio.test.tsx`
 * ("a keystroke hands the sidebar, the rail and the toolbar the props they already had"):
 * a memo wrapper bails out only while every prop it compares keeps its identity. Removing
 * the `React.memo` wrapper from any child makes its entry below fail.
 */

const REACT_MEMO = Symbol.for("react.memo");

function isMemoized(component: unknown): boolean {
  return (
    typeof component === "object" && component !== null && (component as { $$typeof?: unknown }).$$typeof === REACT_MEMO
  );
}

describe("studio children are wrapped in React.memo (X5)", () => {
  test.each([
    ["Sidebar", Sidebar],
    ["ConnectionsList", ConnectionsList],
    ["SchemaExplorer", SchemaExplorer],
    ["AgentRail", AgentRail],
    ["AnswerCard", AnswerCard],
    ["BottomPanel", BottomPanel],
    ["QueryToolbar", QueryToolbar],
    ["StudioDesktopHeader", StudioDesktopHeader],
    ["StudioMobileHeader", StudioMobileHeader],
    ["StudioTabBar", StudioTabBar],
  ])("%s is memoized", (_name, component) => {
    expect(isMemoized(component)).toBe(true);
  });
});
