// Pure helpers for the instruction files OpenCode loads into the agent's system prompt (AGENTS.md, CLAUDE.md,
// configured instruction globs, and harness briefs such as Multica's per-task AGENTS.md). OpenCode prefixes each
// file with an "Instructions from: <path>" line.

export interface Instruction {
  path: string
  text: string
}

const header = /^Instructions from: (.+)$/gm
// What follows the last instruction file inside the same system part.
const trailer = /\n\s*(?:Today's date:|<env>|<available_skills>|# Code Mode\b)/

/** Instruction files in system prompt parts, in order. */
export function extractInstructions(parts: ReadonlyArray<string>): Instruction[] {
  const found: Instruction[] = []
  for (const part of parts) {
    const matches = [...part.matchAll(header)]
    matches.forEach((match, index) => {
      const start = match.index! + match[0].length
      const end = index + 1 < matches.length ? matches[index + 1]!.index! : part.length
      let text = part.slice(start, end)
      const cut = text.search(trailer)
      if (cut >= 0) text = text.slice(0, cut)
      text = text.trim()
      if (text) found.push({ path: match[1]!.trim(), text })
    })
  }
  return found
}

/**
 * Pin instructions per session: the first version of each file is kept, so an agent that later edits an
 * AGENTS.md cannot remove a rule. Files that appear later are appended.
 */
export function pinInstructions(pinned: ReadonlyArray<Instruction>, current: ReadonlyArray<Instruction>) {
  const known = new Set(pinned.map((item) => item.path))
  const added = current.filter((item) => !known.has(item.path))
  return added.length ? [...pinned, ...added] : undefined
}

/** Render within a character budget, shared fairly so one long file cannot crowd out a short one. */
export function renderInstructions(items: ReadonlyArray<Instruction>, limit: number) {
  if (!items.length || limit <= 0) return ""
  const budget = new Map<Instruction, number>()
  let remaining = limit
  const bySize = [...items].sort((a, b) => a.text.length - b.text.length)
  bySize.forEach((item, index) => {
    const share = Math.floor(remaining / (bySize.length - index))
    const take = Math.min(item.text.length, share)
    budget.set(item, take)
    remaining -= take
  })
  return items
    .map((item) => {
      const take = budget.get(item)!
      const text = take < item.text.length ? `${item.text.slice(0, take)}\n…[truncated]` : item.text
      return `<instruction_file path="${item.path}">\n${text}\n</instruction_file>`
    })
    .join("\n")
}
