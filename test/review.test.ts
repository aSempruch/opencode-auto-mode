import { describe, expect, test } from "bun:test"
import {
  buildPrompt,
  selectTurns,
  decideOutcome,
  defaults,
  isReadOnlyShell,
  parseToggle,
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

  test("reviews every allowed action except trusted ones", () => {
    expect(shouldReview("shell", "allow", defaults)).toBe(true)
    expect(shouldReview("webfetch", "allow", defaults)).toBe(true)
    expect(shouldReview("websearch", "allow", defaults)).toBe(true)
    expect(shouldReview("slack_send_message", "allow", defaults)).toBe(true)
    expect(shouldReview("remote-workspace_exec", "allow", defaults)).toBe(true)
    expect(shouldReview("read", "allow", defaults, ["src/a.ts"])).toBe(false)
    expect(shouldReview("edit", "allow", defaults, ["src/a.ts"])).toBe(false)
  })

  test("an explicit review list reviews only what it names", () => {
    const options = { ...defaults, review: ["shell"] }
    expect(shouldReview("shell", "allow", options)).toBe(true)
    expect(shouldReview("webfetch", "allow", options)).toBe(false)
  })

  test("trusted actions are still reviewed when they ask", () => {
    expect(shouldReview("read", "ask", defaults, [".env"])).toBe(true)
  })

  test("edits to configuration are reviewed even though edits are trusted", () => {
    for (const file of [".npmrc", "pip.conf", "pyproject.toml", ".git/hooks/pre-commit", ".github/workflows/ci.yml", "/home/dev/.zshrc", "Makefile", ".cargo/config.toml"])
      expect(shouldReview("edit", "allow", defaults, [file])).toBe(true)
    expect(shouldReview("write", "allow", defaults, ["src/npmrc.ts"])).toBe(false)
    expect(shouldReview("edit", "allow", { ...defaults, reviewPaths: ["^deploy/"] }, ["deploy/run.sh"])).toBe(true)
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
    const prompt = buildPrompt({ turns: [{ kind: "user", id: "1", text: "fix the failing test" }], action })
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

describe("context sections", () => {
  test("labels agent text, answers, parent instructions, summary and tool calls as untrusted", () => {
    const prompt = buildPrompt({
      task: "build the CSV export, push when green",
      turns: [
        { kind: "user", id: "2", agent: "Should I force-push?", text: "yes" },
        { kind: "answer", id: "3", question: "Run migration?", answer: "Yes" },
      ],
      parentInstructions: ["split auth.ts"],
      summary: "earlier work",
      toolCalls: [{ name: "shell", status: "completed", input: '{"command":"mkdir tmp"}' }],
      action: "Permission: shell",
    })
    expect(prompt).toContain("<task>\nbuild the CSV export, push when green\n</task>")
    expect(prompt).toContain("<agent_message untrusted>\nShould I force-push?\n</agent_message>\n<user>\nyes\n</user>")
    expect(prompt).toContain("<agent_question untrusted>\nRun migration?\n</agent_question>\n<user_answer>\nYes\n</user_answer>")
    expect(prompt).toContain("<parent_agent_instructions untrusted>")
    expect(prompt).toContain("<earlier_summary untrusted>")
    expect(prompt).toContain('- shell [completed] {"command":"mkdir tmp"}')
  })

  test("omits optional sections when empty", () => {
    const prompt = buildPrompt({ turns: [], action: "x" })
    expect(prompt).not.toContain("<task>\n")
    expect(prompt).not.toContain("<recent_tool_calls untrusted>")
    expect(prompt).toContain("(no user messages available)")
  })
})

describe("selectTurns", () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({ kind: "user" as const, id: String(index).padStart(2, "0"), text: `m${index}` }))

  test("pins the first message outside the window", () => {
    const selected = selectTurns(turns, 8, true)
    expect(selected.task).toBe("m0")
    expect(selected.turns.map((turn) => (turn.kind === "user" ? turn.text : ""))).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11"])
  })

  test("does not duplicate the first message when it is in the window", () => {
    expect(selectTurns(turns.slice(0, 5), 8, true).task).toBeUndefined()
  })

  test("pinning can be disabled", () => {
    expect(selectTurns(turns, 8, false).task).toBeUndefined()
  })
})

describe("decideOutcome", () => {
  const base = { onBlock: "deny" as const, onError: "ask" as const, escalation: "deny" as const, maxConsecutiveBlocks: 3 }

  test("allow passes through", () => {
    expect(decideOutcome({ decision: "allow", reason: "" }, 0, base)).toEqual({ effect: "allow" })
  })

  test("block denies with the reason", () => {
    const outcome = decideOutcome({ decision: "block", reason: "exfiltration" }, 1, base)
    expect(outcome.effect).toBe("deny")
    expect(outcome.message).toContain("exfiltration")
  })

  test("escalations deny and ask for conversational confirmation by default", () => {
    for (const outcome of [
      decideOutcome({ decision: "ask", reason: "unclear" }, 0, base),
      decideOutcome(undefined, 0, base),
      decideOutcome({ decision: "block", reason: "x" }, 3, base),
    ]) {
      expect(outcome.effect).toBe("deny")
      expect(outcome.message).toContain("confirm this exact action in the conversation")
    }
  })

  test("escalation: ask restores native prompts", () => {
    const ask = { ...base, escalation: "ask" as const }
    expect(decideOutcome({ decision: "ask", reason: "unclear" }, 0, ask).effect).toBe("ask")
    expect(decideOutcome(undefined, 0, ask).effect).toBe("ask")
    expect(decideOutcome({ decision: "block", reason: "x" }, 3, ask).effect).toBe("ask")
    expect(decideOutcome({ decision: "block", reason: "x" }, 1, ask).effect).toBe("deny")
  })

  test("onError allow and deny are honored", () => {
    expect(decideOutcome(undefined, 0, { ...base, onError: "allow" })).toEqual({ effect: "allow", message: undefined })
    expect(decideOutcome(undefined, 0, { ...base, onError: "deny" }).effect).toBe("deny")
  })
})

describe("parseToggle", () => {
  test("explicit states", () => {
    expect(parseToggle("off")).toBe("off")
    expect(parseToggle(" ON ")).toBe("on")
    expect(parseToggle("pause")).toBe("off")
    expect(parseToggle("status")).toBe("status")
  })
  test("no argument flips", () => {
    expect(parseToggle("")).toBe("flip")
    expect(parseToggle(undefined)).toBe("flip")
    expect(parseToggle("/auto-mode")).toBe("flip")
  })
  test("tolerates the command name and extra words", () => {
    expect(parseToggle("/auto-mode off please")).toBe("off")
  })
  test("unknown argument", () => {
    expect(parseToggle("maybe")).toBeUndefined()
  })
})
