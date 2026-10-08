import { describe, expect, it } from "vitest";
import { slug, taskBranch } from "./branch";

describe("branch names", () => {
  // The cases of TestSlug in internal/runner/workspace_test.go: the web names the branch the Runner makes.
  it.each([
    ["Cart page", "cart-page"],
    ["  Fix: the API's 500 on /v1/tasks!! ", "fix-the-api-s-500-on-v1-tasks"],
    ["Break down: Checkout", "break-down-checkout"],
    ["Ünïcode only ✓", "n-code-only"],
    ["!!!", "task"],
    ["A very long title that keeps going well past forty characters", "a-very-long-title-that-keeps-going-well"],
  ])("slug(%j) is %j", (title, want) => {
    expect(slug(title)).toBe(want);
  });

  it("lowers each character to one, as Go does", () => {
    expect(slug("İstanbul \u212Aelvin")).toBe("istanbul-kelvin");
  });

  it("cuts at 40 characters, on the last dash when it falls past the 20th", () => {
    expect(slug("a".repeat(50))).toBe("a".repeat(40));
    expect(slug(`${"a".repeat(10)} ${"b".repeat(40)}`)).toBe(`${"a".repeat(10)}-${"b".repeat(29)}`);
  });

  it("names a Task's branch by its key in lower case, then its slug", () => {
    expect(taskBranch("MAIN-7", "Support emoji")).toBe("main-7-support-emoji");
  });
});
