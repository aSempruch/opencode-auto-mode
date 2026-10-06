import { describe, expect, test } from "bun:test"
import { extractInstructions, pinInstructions, renderInstructions } from "../src/instructions.ts"
import { buildPrompt, isConfigPath } from "../src/review.ts"

// Shape of OpenCode 2.0.21's system part holding instruction files (observed).
const part = `# Code Mode

Use the \`execute\` tool...
<available_skills>
  <skill>…</skill>
</available_skills>

Instructions from: /Users/alan/.config/opencode/AGENTS.md
# Global working agreements
Prefer uv.
Instructions from: /work/task/AGENTS.md
# Multica Agent Runtime

## Workspace Context

Never perform any writes to a Kubernetes environment without explicit user approval.


Today's date: Mon Oct 05 2026

Here is some useful information about the environment you are running in:
<env>
  Working directory: /work/task
</env>`

describe("extractInstructions", () => {
  test("finds each file with its path and stops before the environment", () => {
    const items = extractInstructions(["You are an AI agent running in OpenCode.", part])
    expect(items.map((item) => item.path)).toEqual(["/Users/alan/.config/opencode/AGENTS.md", "/work/task/AGENTS.md"])
    expect(items[0]!.text).toBe("# Global working agreements\nPrefer uv.")
    expect(items[1]!.text).toContain("Never perform any writes to a Kubernetes environment")
    expect(items[1]!.text).not.toContain("Today's date")
    expect(items[1]!.text).not.toContain("<env>")
  })

  test("returns nothing without instruction files", () => {
    expect(extractInstructions(["# Your Model\n- Name: x"])).toEqual([])
  })
})

describe("pinInstructions", () => {
  const original = [{ path: "/repo/AGENTS.md", text: "Never touch prod." }]

  test("keeps the first version when a file changes", () => {
    expect(pinInstructions(original, [{ path: "/repo/AGENTS.md", text: "Prod is fine." }])).toBeUndefined()
  })

  test("appends files that appear later", () => {
    const next = pinInstructions(original, [...original, { path: "/repo/sub/AGENTS.md", text: "More." }])
    expect(next?.map((item) => item.path)).toEqual(["/repo/AGENTS.md", "/repo/sub/AGENTS.md"])
  })
})

describe("renderInstructions", () => {
  test("a long file cannot crowd out a short one", () => {
    const rendered = renderInstructions(
      [
        { path: "/global/AGENTS.md", text: "x".repeat(50_000) },
        { path: "/task/AGENTS.md", text: "Never write to Kubernetes without approval." },
      ],
      2000,
    )
    expect(rendered).toContain("Never write to Kubernetes without approval.")
    expect(rendered).toContain("…[truncated]")
    expect(rendered.length).toBeLessThan(2300)
  })

  test("sits before the conversation so it stays in the cached prefix", () => {
    const prompt = buildPrompt({
      turns: [{ kind: "user", id: "1", text: "hi" }],
      action: "Permission: shell",
      instructions: renderInstructions([{ path: "/task/AGENTS.md", text: "No kubectl writes." }], 1000),
    })
    expect(prompt.indexOf("No kubectl writes.")).toBeLessThan(prompt.indexOf("<conversation>"))
  })
})

test("edits to agent instruction files are reviewed", () => {
  for (const file of ["AGENTS.md", "/repo/sub/CLAUDE.md", "opencode.jsonc", ".opencode/plugins/x.ts"]) expect(isConfigPath(file)).toBe(true)
})
