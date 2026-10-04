import { describe, expect, test } from "bun:test"
import {
  buildPrompt,
  defaults,
  isReadOnlyShell,
  parseVerdict,
  renderAction,
  resolveOptions,
  shouldReview,
} from "../src/review.ts"

describe("parseVerdict", () => {
  test("plain JSON", () => {
    expect(parseVerdict('{"decision": "allow", "reason": "Runs tests."}')).toEqual({
      decision: "allow",
      reason: "Runs tests.",
    })
  })

  test("ignores think blocks and prose around the JSON", () => {
    const text = '<think>maybe {"decision":"allow"}</think>\nSure.\n{"decision": "BLOCK", "reason": "Pushes to remote."}'
    expect(parseVerdict(text)).toEqual({ decision: "block", reason: "Pushes to remote." })
  })

  test("handles an unterminated leading think section", () => {
    expect(parseVerdict('reasoning...</think>{"decision":"block","reason":"x"}')?.decision).toBe("block")
  })

  test("uses the last verdict when several appear", () => {
    expect(parseVerdict('{"decision":"allow"} then {"decision":"block","reason":"r"}')?.decision).toBe("block")
  })

  test("falls back to a bare keyword", () => {
    expect(parseVerdict("BLOCK - deletes home directory")).toEqual({ decision: "block", reason: "" })
    expect(parseVerdict('decision: "allow"')).toEqual({ decision: "allow", reason: "" })
  })

  test("returns undefined for no verdict", () => {
    expect(parseVerdict("I am not sure.")).toBeUndefined()
    expect(parseVerdict('{"decision":"maybe"}')).toBeUndefined()
    expect(parseVerdict("")).toBeUndefined()
  })
})

describe("isReadOnlyShell", () => {
  test("allows simple reads", () => {
    expect(isReadOnlyShell(["ls -la"])).toBe(true)
    expect(isReadOnlyShell(["git status", "git diff --stat"])).toBe(true)
    expect(isReadOnlyShell(["rg foo src", "head -20"])).toBe(true)
  })

  test("rejects writes, chaining and substitution", () => {
    expect(isReadOnlyShell(["echo hi > file.txt"])).toBe(false)
    expect(isReadOnlyShell(["cat $(which foo)"])).toBe(false)
    expect(isReadOnlyShell(["ls; rm -rf /"])).toBe(false)
    expect(isReadOnlyShell(["rm -rf build"])).toBe(false)
    expect(isReadOnlyShell(["git push"])).toBe(false)
    expect(isReadOnlyShell(["git branch -D main"])).toBe(false)
    expect(isReadOnlyShell(["git remote add origin x"])).toBe(false)
    expect(isReadOnlyShell(["rg --pre ./evil.sh foo"])).toBe(false)
    expect(isReadOnlyShell(["sort -o out.txt in.txt"])).toBe(false)
  })

  test("allows listing forms of git branch/tag/remote", () => {
    expect(isReadOnlyShell(["git branch"])).toBe(true)
    expect(isReadOnlyShell(["git branch -a"])).toBe(true)
    expect(isReadOnlyShell(["git remote -v"])).toBe(true)
  })

  test("rejects anything touching secrets", () => {
    expect(isReadOnlyShell(["cat .env"])).toBe(false)
    expect(isReadOnlyShell(["cat ~/.ssh/id_ed25519"])).toBe(false)
    expect(isReadOnlyShell(["grep -r API_TOKEN ."])).toBe(false)
  })

  test("rejects empty input", () => {
    expect(isReadOnlyShell([])).toBe(false)
  })
})

describe("shouldReview", () => {
  test("always reviews ask, never deny", () => {
    expect(shouldReview("edit", "ask", defaults)).toBe(true)
    expect(shouldReview("shell", "deny", defaults)).toBe(false)
  })

  test("reviews allowed actions only when listed", () => {
    expect(shouldReview("shell", "allow", defaults)).toBe(true)
    expect(shouldReview("edit", "allow", defaults)).toBe(false)
    expect(shouldReview("edit", "allow", { ...defaults, review: ["*"] })).toBe(true)
  })

  test("skip wins", () => {
    expect(shouldReview("question", "ask", defaults)).toBe(false)
  })
})

describe("resolveOptions", () => {
  test("falls back on invalid values", () => {
    const options = resolveOptions({ review: "shell", userMessages: -1, onError: "nope", onBlock: "ask", variant: "low" })
    expect(options.review).toEqual(defaults.review)
    expect(options.userMessages).toBe(defaults.userMessages)
    expect(options.onError).toBe("ask")
    expect(options.onBlock).toBe("ask")
    expect(options.variant).toBe("low")
  })
})

describe("prompt", () => {
  test("includes user messages and the action", () => {
    const action = renderAction(
      { action: "shell", resources: ["npm test"], tool: "shell", input: { command: "npm test" }, directory: "/repo" },
      1000,
    )
    const prompt = buildPrompt({ userMessages: ["fix the failing test"], action })
    expect(prompt).toContain("fix the failing test")
    expect(prompt).toContain("Working directory: /repo")
    expect(prompt).toContain('"command": "npm test"')
  })

  test("truncates long actions", () => {
    const action = renderAction({ action: "edit", resources: ["a"], metadata: { diff: "x".repeat(500) } }, 100)
    expect(action.length).toBeLessThan(160)
    expect(action).toContain("truncated")
  })
})

describe("ask verdict", () => {
  test("parses ask", () => {
    expect(parseVerdict('{"decision":"ask","reason":"unclear scope"}')).toEqual({ decision: "ask", reason: "unclear scope" })
  })
})
