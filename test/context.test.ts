import { describe, expect, test } from "bun:test"
import {
  answerTurns,
  capTurns,
  lastAgentText,
  latestCompaction,
  mergeTurns,
  toolCallsFromContext,
  turnsFromContext,
  type ContextMessage,
} from "../src/context.ts"
import type { Turn } from "../src/review.ts"

// Shapes mirror OpenCode 2 Session.Message variants.
const model = { providerID: "alanpc", id: "qwen" }
const messages: ContextMessage[] = [
  { type: "compaction", id: "msg_01", status: "completed", summary: "Earlier: set up the repo." },
  { type: "user", id: "msg_02", text: "clean up the branch history" },
  {
    type: "assistant",
    id: "msg_03",
    model,
    content: [
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "I squashed the commits. Should I force-push?" },
      { type: "tool", id: "call_a", name: "shell", state: { status: "completed", input: { command: "git rebase -i" } } },
    ],
  },
  { type: "user", id: "msg_04", text: "yes" },
  {
    type: "assistant",
    id: "msg_05",
    model,
    content: [
      {
        type: "tool",
        id: "call_q",
        name: "question",
        state: {
          status: "completed",
          input: { questions: [{ question: "Push to which remote?", header: "Remote", options: [] }] },
          metadata: { answers: [["origin"]] },
        },
      },
      { type: "tool", id: "call_now", name: "shell", state: { status: "running", input: { command: "git push -f" } } },
    ],
  },
]

describe("turnsFromContext", () => {
  test("pairs each user message with the preceding agent text and extracts question answers", () => {
    const turns = turnsFromContext(messages, { agentChars: 600, messageChars: 2000 })
    expect(turns).toEqual([
      { kind: "user", id: "msg_02", text: "clean up the branch history" },
      { kind: "user", id: "msg_04", text: "yes", agent: "I squashed the commits. Should I force-push?" },
      { kind: "answer", id: "msg_05:call_q:0", question: "Push to which remote?", answer: "origin" },
    ])
  })

  test("agent context can be disabled and is truncated", () => {
    const off = turnsFromContext(messages, { agentChars: 0, messageChars: 2000 })
    expect(off.every((turn) => turn.kind !== "user" || turn.agent === undefined)).toBe(true)
    const short = turnsFromContext(messages, { agentChars: 10, messageChars: 2000 })
    expect(short[1]).toMatchObject({ agent: "I squashed…[truncated]" })
  })

  test("ignores unanswered or cancelled questions", () => {
    expect(answerTurns("m", "c", { questions: [{ question: "Q?" }] }, [[]], 100)).toEqual([])
    expect(answerTurns("m", "c", { questions: [{ question: "Q?" }] }, undefined, 100)).toEqual([])
  })
})

describe("lastAgentText", () => {
  test("returns the latest assistant text since the last user message", () => {
    expect(lastAgentText(messages.slice(0, 3))).toBe("I squashed the commits. Should I force-push?")
    expect(lastAgentText(messages.slice(0, 2))).toBeUndefined()
  })
})

describe("toolCallsFromContext", () => {
  test("lists recent calls, skipping question tools and the call under review", () => {
    expect(toolCallsFromContext(messages, { limit: 5, exclude: "call_now", inputChars: 200 })).toEqual([
      { name: "shell", status: "completed", input: '{"command":"git rebase -i"}' },
    ])
    expect(toolCallsFromContext(messages, { limit: 0, inputChars: 200 })).toEqual([])
  })
})

describe("latestCompaction", () => {
  test("finds the completed compaction summary", () => {
    expect(latestCompaction(messages)).toEqual({ id: "msg_01", summary: "Earlier: set up the repo." })
    expect(latestCompaction(messages.slice(1))).toBeUndefined()
  })
})

describe("mergeTurns / capTurns", () => {
  test("dedupes by id, prefers the copy with agent context, sorts chronologically", () => {
    const stored: Turn[] = [
      { kind: "user", id: "msg_00", text: "original task from before compaction" },
      { kind: "user", id: "msg_04", text: "yes", agent: "Should I force-push?" },
    ]
    const fromContext: Turn[] = [
      { kind: "user", id: "msg_04", text: "yes" },
      { kind: "user", id: "msg_02", text: "clean up" },
    ]
    expect(mergeTurns(stored, fromContext).map((turn) => turn.id)).toEqual(["msg_00", "msg_02", "msg_04"])
    expect(mergeTurns(fromContext, stored).find((turn) => turn.id === "msg_04")).toMatchObject({ agent: "Should I force-push?" })
  })

  test("caps while keeping the first user turn", () => {
    const turns: Turn[] = Array.from({ length: 10 }, (_, index) => ({ kind: "user", id: `m${index}`, text: String(index) }))
    expect(capTurns(turns, 3).map((turn) => turn.id)).toEqual(["m0", "m7", "m8", "m9"])
  })
})
