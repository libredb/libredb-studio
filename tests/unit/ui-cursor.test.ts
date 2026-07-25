import { describe, test, expect } from "bun:test";
import { buttonVariants } from "@/components/ui/button";
import { toggleVariants } from "@/components/ui/toggle";
import { navigationMenuTriggerStyle } from "@/components/ui/navigation-menu";

describe("interactive UI primitives include cursor-pointer", () => {
  test("buttonVariants base classes include cursor-pointer", () => {
    expect(buttonVariants()).toContain("cursor-pointer");
  });

  test("toggleVariants base classes include cursor-pointer", () => {
    expect(toggleVariants()).toContain("cursor-pointer");
  });

  test("navigationMenuTriggerStyle includes cursor-pointer", () => {
    expect(navigationMenuTriggerStyle()).toContain("cursor-pointer");
  });
});
