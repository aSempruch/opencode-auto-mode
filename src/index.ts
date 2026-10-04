import type { Plugin } from "@opencode/plugin"
import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildPrompt,
  isReadOnlyShell,
  parseVerdict,
  renderAction,
  resolveOptions,
  shouldReview,
  type Effect,
} from "./review.ts"

type ModelRef = { providerID: string; id: string; variant?: string }

// Loose views of the message shapes returned by ctx.session.context.
type ToolContent = { type: "tool"; id: string; name: string; state: { status: string; input?: unknown } }
type ContextMessage =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; model: ModelRef; content: ReadonlyArray<{ type: string }> }
  | { type: string; id: string }

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
    const streaks = new Map<string, number>()
    const allowed = new Map<string, number>()

    const log = async (entry: Record<string, unknown>) => {
      if (!logFile) return
      try {
        await mkdir(path.dirname(logFile), { recursive: true })
        await appendFile(logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n")
      } catch {}
    }

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

      const key = JSON.stringify([event.sessionID, event.action, event.resources])
      const cached = allowed.get(key)
      if (cached !== undefined && Date.now() - cached < options.cacheMs) return decide("allow", undefined, "cache")

      let messages: ReadonlyArray<ContextMessage> = []
      try {
        messages = (await ctx.session.context({ sessionID: event.sessionID })) as unknown as ReadonlyArray<ContextMessage>
      } catch (error) {
        void log({ ...base, warning: `session.context failed: ${String(error)}` })
      }

      // Review with the model that issued this tool call, so no other model has to be loaded.
      const source = event.source
      const origin = source
        ? (messages.find((message) => message.id === source.messageID && message.type === "assistant") as
            | Extract<ContextMessage, { type: "assistant" }>
            | undefined)
        : undefined
      let model: ModelRef | undefined = origin?.model
      if (!model) {
        try {
          model = (await ctx.session.get({ sessionID: event.sessionID })).model as ModelRef | undefined
        } catch {}
      }
      if (model && options.variant) model = { ...model, variant: options.variant }
      const call = source
        ? (origin?.content.find((item) => item.type === "tool" && (item as ToolContent).id === source.id) as
            | ToolContent
            | undefined)
        : undefined

      const userMessages = messages
        .filter((message): message is Extract<ContextMessage, { type: "user" }> => message.type === "user")
        .map((message) => message.text.trim())
        .filter(Boolean)
        .slice(-options.userMessages)
        .map((text) =>
          text.length > options.maxMessageChars ? `${text.slice(0, options.maxMessageChars)}…[truncated]` : text,
        )

      const prompt = buildPrompt({
        userMessages,
        action: renderAction(
          {
            action: event.action,
            effect: original,
            resources: event.resources,
            tool: call?.name,
            input: call && call.state.status !== "streaming" ? call.state.input : undefined,
            metadata: event.metadata,
            directory: ctx.location.directory,
          },
          options.maxActionChars,
        ),
      })

      // Same route OpenCode uses for chat: the server resolves provider, credentials and options for this model.
      const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
      const generate = () => ctx.generate.text({ prompt, ...(model ? { model } : {}) }, { signal })
      let text: string
      try {
        text = (await generate().catch(async (error) => {
          if (signal?.aborted) throw error
          await new Promise((resolve) => setTimeout(resolve, 1000))
          return generate()
        })).text
      } catch (error) {
        return decide(options.onError, `Auto-mode reviewer failed: ${String(error)}`, "error", { model })
      }

      const verdict = parseVerdict(text)
      if (!verdict) {
        return decide(options.onError, "Auto-mode reviewer gave no clear verdict.", "unparseable", {
          model,
          reply: text.slice(0, 500),
        })
      }

      if (verdict.decision === "allow") {
        streaks.delete(event.sessionID)
        allowed.set(key, Date.now())
        return decide("allow", undefined, "model", { model, reason: verdict.reason })
      }

      if (verdict.decision === "ask") {
        return decide("ask", `Auto-mode is unsure: ${verdict.reason || "no reason given"}`, "model", {
          model,
          reason: verdict.reason,
        })
      }

      const streak = (streaks.get(event.sessionID) ?? 0) + 1
      streaks.set(event.sessionID, streak)
      const reason = verdict.reason || "no reason given"
      if (options.onBlock === "ask" || (options.maxConsecutiveBlocks > 0 && streak >= options.maxConsecutiveBlocks)) {
        if (options.onBlock !== "ask") streaks.delete(event.sessionID)
        return decide("ask", `Auto-mode flagged this: ${reason}`, "model", { model, reason, streak })
      }
      return decide(
        "deny",
        `Blocked by auto-mode safety review: ${reason} Choose a safer approach, or ask the user to run or approve it explicitly.`,
        "model",
        { model, reason, streak },
      )
    })

    return () => {
      streaks.clear()
      allowed.clear()
    }
  },
}

export default plugin
