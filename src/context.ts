// Pure extraction of reviewer context from OpenCode session messages
// (the shapes returned by ctx.session.context). Message IDs are ascending, so
// sorting by ID is chronological.

import type { ToolCallSummary, Turn } from "./review.ts"

type Content = { type: string; text?: string; id?: string; name?: string; state?: ToolState }
type ToolState = { status: string; input?: unknown; metadata?: Record<string, unknown>; output?: unknown }
export type ContextMessage = {
  type: string
  id: string
  text?: string
  status?: string
  summary?: string
  model?: { providerID: string; id: string; variant?: string }
  content?: ReadonlyArray<Content>
}

export function clip(text: string, limit: number) {
  const trimmed = text.trim()
  if (limit <= 0 || trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}…[truncated]`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Turns from answered question-tool calls: the agent's question paired with the user's answer. */
export function answerTurns(messageID: string, callID: string, input: unknown, answers: unknown, limit: number): Turn[] {
  const questions = record(input)?.questions
  if (!Array.isArray(questions) || !Array.isArray(answers)) return []
  return questions.flatMap((question, index): Turn[] => {
    const text = record(question)?.question
    const answer = answers[index]
    const values = Array.isArray(answer) ? answer.map(String) : answer === undefined ? [] : [String(answer)]
    if (typeof text !== "string" || values.length === 0) return []
    return [
      {
        kind: "answer",
        id: `${messageID}:${callID}:${index}`,
        question: clip(text, limit),
        answer: clip(values.join(", "), limit),
      },
    ]
  })
}

/** The last assistant text in `messages` (the agent's message the user would be replying to). */
export function lastAgentText(messages: ReadonlyArray<ContextMessage>) {
  for (const message of messages.toReversed()) {
    if (message.type === "user") return undefined
    if (message.type !== "assistant") continue
    const text = (message.content ?? [])
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}

export function turnsFromContext(
  messages: ReadonlyArray<ContextMessage>,
  options: { agentChars: number; messageChars: number },
): Turn[] {
  const turns: Turn[] = []
  let agent: string | undefined
  for (const message of messages) {
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
      turns.push({
        kind: "user",
        id: message.id,
        text: clip(message.text, options.messageChars),
        ...(agent && options.agentChars > 0 ? { agent: clip(agent, options.agentChars) } : {}),
      })
      agent = undefined
      continue
    }
    if (message.type !== "assistant") continue
    const text = (message.content ?? [])
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text)
      .join("\n")
      .trim()
    if (text) agent = text
    for (const item of message.content ?? []) {
      if (item.type !== "tool" || item.name !== "question" || item.state?.status !== "completed") continue
      const answers = item.state.metadata?.answers ?? record(item.state.output)?.answers
      turns.push(...answerTurns(message.id, item.id ?? "", item.state.input, answers, options.messageChars))
    }
  }
  return turns
}

/** Merge stored and context turns by ID, preferring the copy that carries agent context. */
export function mergeTurns(...sources: ReadonlyArray<Turn>[]) {
  const byID = new Map<string, Turn>()
  for (const turn of sources.flat()) {
    const existing = byID.get(turn.id)
    if (!existing || (turn.kind === "user" && turn.agent && !(existing.kind === "user" && existing.agent)))
      byID.set(turn.id, turn)
  }
  return [...byID.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Keep the first user turn and the most recent `limit` turns. */
export function capTurns(turns: Turn[], limit: number) {
  if (turns.length <= limit) return turns
  const first = turns.find((turn) => turn.kind === "user")
  const recent = turns.slice(-limit)
  return first && !recent.includes(first) ? [first, ...recent] : recent
}

export function toolCallsFromContext(
  messages: ReadonlyArray<ContextMessage>,
  options: { limit: number; exclude?: string; inputChars: number },
): ToolCallSummary[] {
  if (options.limit <= 0) return []
  const calls: ToolCallSummary[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const item of message.content ?? []) {
      if (item.type !== "tool" || !item.name || item.name === "question" || item.id === options.exclude) continue
      let input = ""
      try {
        input = JSON.stringify(item.state?.input ?? {})
      } catch {}
      calls.push({ name: item.name, status: item.state?.status ?? "unknown", input: clip(input, options.inputChars) })
    }
  }
  return calls.slice(-options.limit)
}

/** The latest completed compaction, if any. */
export function latestCompaction(messages: ReadonlyArray<ContextMessage>) {
  const compaction = messages.findLast((message) => message.type === "compaction" && message.status === "completed")
  return compaction && typeof compaction.summary === "string" ? { id: compaction.id, summary: compaction.summary } : undefined
}
