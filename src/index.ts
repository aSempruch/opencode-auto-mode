import type { Plugin } from "@opencode/plugin"
import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  answerTurns,
  capTurns,
  clip,
  lastAgentText,
  latestCompaction,
  mergeTurns,
  toolCallsFromContext,
  turnsFromContext,
  type ContextMessage,
} from "./context.ts"
import {
  buildPrompt,
  isReadOnlyShell,
  parseVerdict,
  renderAction,
  resolveOptions,
  selectTurns,
  shouldReview,
  type Effect,
  type Turn,
} from "./review.ts"

type ModelRef = { providerID: string; id: string; variant?: string }

// Durable per-session record of the user's turns, so authorization survives compaction.
const STORED_TURNS = 60
const MAX_PARENT_DEPTH = 8
const SUMMARY_CHARS = 2000
const TOOL_INPUT_CHARS = 200

function defaultLogFile() {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "auto-mode.jsonl")
}

const plugin: Plugin.Plugin = {
  id: "auto-mode",
  async setup(ctx) {
    const options = resolveOptions(ctx.options)
    const logFile =
      ctx.options.logFile === false ? undefined : typeof ctx.options.logFile === "string" ? ctx.options.logFile : defaultLogFile()
    const logPrompt = ctx.options.logPrompt === true
    const streaks = new Map<string, number>()
    const allowed = new Map<string, number>()
    const writes = new Map<string, Promise<void>>()

    const log = async (entry: Record<string, unknown>) => {
      if (!logFile) return
      try {
        await mkdir(path.dirname(logFile), { recursive: true })
        await appendFile(logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n")
      } catch {}
    }

    const key = (sessionID: string) => `turns/${sessionID}`
    const loadTurns = async (sessionID: string): Promise<Turn[]> => {
      try {
        const value = await ctx.storage.get(key(sessionID))
        return Array.isArray(value) ? (value as unknown as Turn[]) : []
      } catch {
        return []
      }
    }
    // Serialize writes per session so concurrent captures don't drop each other.
    const record = (sessionID: string, produce: () => Promise<Turn[]>) => {
      const next = (writes.get(sessionID) ?? Promise.resolve()).then(async () => {
        try {
          const turns = await produce()
          if (!turns.length) return
          const merged = capTurns(mergeTurns(await loadTurns(sessionID), turns), STORED_TURNS)
          await ctx.storage.set(key(sessionID), merged as unknown as Parameters<typeof ctx.storage.set>[1])
        } catch (error) {
          void log({ sessionID, warning: `failed to record turn: ${String(error)}` })
        }
      })
      writes.set(sessionID, next)
      return next
    }
    const contextOf = async (sessionID: string) => {
      try {
        return (await ctx.session.context({ sessionID })) as unknown as ReadonlyArray<ContextMessage>
      } catch (error) {
        void log({ sessionID, warning: `session.context failed: ${String(error)}` })
        return []
      }
    }

    // Capture each user prompt at admission, with the agent message it replies to.
    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text
      if (!text?.trim()) return
      void record(event.sessionID, async () => {
        const agent = options.agentContextChars > 0 ? lastAgentText(await contextOf(event.sessionID)) : undefined
        return [
          {
            kind: "user",
            id: event.messageID,
            text: clip(text, options.maxMessageChars),
            ...(agent ? { agent: clip(agent, options.agentContextChars) } : {}),
          },
        ]
      })
    })

    // Capture answers given through the question tool; they are user input too.
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "question" || event.status !== "completed") return
      const result = event.result as { output?: { answers?: unknown }; metadata?: { answers?: unknown } }
      const answers = result.metadata?.answers ?? result.output?.answers
      void record(event.sessionID, async () =>
        answerTurns(event.messageID, event.id, event.input, answers, options.maxMessageChars),
      )
    })

    await ctx.permission.hook("evaluate", async (event) => {
      const original = event.effect as Effect
      if (!shouldReview(event.action, original, options)) return
      const started = Date.now()
      const base = { sessionID: event.sessionID, action: event.action, resources: event.resources, original }

      const decide = (effect: Effect, message: string | undefined, via: string, extra: Record<string, unknown> = {}) => {
        event.effect = effect
        event.message = message
        void log({ ...base, effect, via, message, ms: Date.now() - started, ...extra })
      }

      if (options.fastAllow && event.action === "shell" && isReadOnlyShell(event.resources)) {
        return decide("allow", undefined, "fast-path")
      }

      const cacheKey = JSON.stringify([event.sessionID, event.action, event.resources])
      const cached = allowed.get(cacheKey)
      if (cached !== undefined && Date.now() - cached < options.cacheMs) return decide("allow", undefined, "cache")

      const messages = await contextOf(event.sessionID)

      // Subagents: authorization comes from the user's root session, not the parent agent's instructions.
      let session: { parentID?: string; model?: ModelRef } | undefined
      try {
        session = (await ctx.session.get({ sessionID: event.sessionID })) as typeof session
      } catch {}
      let rootID: string = event.sessionID
      let parentID = session?.parentID
      for (let depth = 0; parentID && depth < MAX_PARENT_DEPTH; depth++) {
        rootID = parentID
        try {
          parentID = ((await ctx.session.get({ sessionID: parentID as typeof event.sessionID })) as { parentID?: string }).parentID
        } catch {
          break
        }
      }
      const rootMessages = rootID === event.sessionID ? messages : await contextOf(rootID)
      await writes.get(rootID)
      const extract = { agentChars: options.agentContextChars, messageChars: options.maxMessageChars }
      const turns = mergeTurns(await loadTurns(rootID), turnsFromContext(rootMessages, extract))
      const selected = selectTurns(turns, options.userMessages, options.pinFirst)

      // Compaction dropped history we have no verbatim record of: show its summary, marked untrusted.
      const compaction = latestCompaction(rootMessages)
      const summary =
        compaction && !turns.some((turn) => turn.id < compaction.id) ? clip(compaction.summary, SUMMARY_CHARS) : undefined

      const parentInstructions =
        rootID === event.sessionID
          ? undefined
          : turnsFromContext(messages, { agentChars: 0, messageChars: options.maxMessageChars })
              .flatMap((turn) => (turn.kind === "user" ? [turn.text] : []))
              .slice(-2)

      // Review with the model that issued this tool call, so no other model has to be loaded.
      const source = event.source
      const origin = source
        ? messages.find((message) => message.id === source.messageID && message.type === "assistant")
        : undefined
      let model: ModelRef | undefined = origin?.model ?? session?.model
      if (model && options.variant) model = { ...model, variant: options.variant }
      const call = source
        ? origin?.content?.find((item) => item.type === "tool" && item.id === source.id)
        : undefined

      const prompt = buildPrompt({
        task: selected.task,
        turns: selected.turns,
        parentInstructions,
        summary,
        toolCalls: toolCallsFromContext(messages, {
          limit: options.toolCalls,
          exclude: source?.id,
          inputChars: TOOL_INPUT_CHARS,
        }),
        action: renderAction(
          {
            action: event.action,
            effect: original,
            resources: event.resources,
            tool: call?.name,
            input: call?.state && call.state.status !== "streaming" ? call.state.input : undefined,
            metadata: event.metadata,
            directory: ctx.location.directory,
          },
          options.maxActionChars,
        ),
      })
      const shape = {
        turns: selected.turns.length,
        pinned: Boolean(selected.task),
        summary: Boolean(summary),
        subagent: rootID !== event.sessionID,
        promptChars: prompt.length,
        ...(logPrompt ? { prompt } : {}),
      }

      // Same route OpenCode uses for chat: the server resolves provider, credentials and options for this model.
      const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
      const generate = () => ctx.generate.text({ prompt, ...(model ? { model } : {}) }, { signal })
      let text: string
      try {
        text = (
          await generate().catch(async (error) => {
            if (signal?.aborted) throw error
            await new Promise((resolve) => setTimeout(resolve, 1000))
            return generate()
          })
        ).text
      } catch (error) {
        return decide(options.onError, `Auto-mode reviewer failed: ${String(error)}`, "error", { model, ...shape })
      }

      const verdict = parseVerdict(text)
      if (!verdict) {
        return decide(options.onError, "Auto-mode reviewer gave no clear verdict.", "unparseable", {
          model,
          ...shape,
          reply: text.slice(0, 500),
        })
      }

      if (verdict.decision === "allow") {
        streaks.delete(event.sessionID)
        allowed.set(cacheKey, Date.now())
        return decide("allow", undefined, "model", { model, ...shape, reason: verdict.reason })
      }

      if (verdict.decision === "ask") {
        return decide("ask", `Auto-mode is unsure: ${verdict.reason || "no reason given"}`, "model", {
          model,
          ...shape,
          reason: verdict.reason,
        })
      }

      const streak = (streaks.get(event.sessionID) ?? 0) + 1
      streaks.set(event.sessionID, streak)
      const reason = verdict.reason || "no reason given"
      if (options.onBlock === "ask" || (options.maxConsecutiveBlocks > 0 && streak >= options.maxConsecutiveBlocks)) {
        if (options.onBlock !== "ask") streaks.delete(event.sessionID)
        return decide("ask", `Auto-mode flagged this: ${reason}`, "model", { model, ...shape, reason, streak })
      }
      return decide(
        "deny",
        `Blocked by auto-mode safety review: ${reason} Choose a safer approach, or ask the user to run or approve it explicitly.`,
        "model",
        { model, ...shape, reason, streak },
      )
    })

    return () => {
      streaks.clear()
      allowed.clear()
    }
  },
}

export default plugin
