import type { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile as fsReadFile, stat } from "node:fs/promises"
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
import { extractInstructions, pinInstructions, renderInstructions, type Instruction } from "./instructions.ts"
import { describeHosts, extractHosts, isWatched, scriptTargets, type ScriptSource } from "./network.ts"
import {
  buildPrompt,
  decideOutcome,
  escalate,
  isReadOnlyShell,
  isConfigEdit,
  isSensitivePath,
  mayUseNetwork,
  parseVerdict,
  renderAction,
  resolveOptions,
  selectTurns,
  shouldReview,
  watchList,
  type Effect,
  type Turn,
} from "./review.ts"

type ModelRef = { providerID: string; id: string; variant?: string }

/** A permission evaluation, or a code-mode snippet presented as one. The result is written to effect/message. */
type Request = {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly messageID: string; readonly id: string }
  /** Tool input, when the caller has it (code mode); otherwise looked up from the session. */
  readonly input?: unknown
  /** Code mode runs outside OpenCode's permission system, so there is no prompt to escalate to. */
  readonly codeMode?: boolean
  effect: Effect
  message?: string
}

// Durable per-session record of the user's turns, so authorization survives compaction.
const STORED_TURNS = 60
const MAX_PARENT_DEPTH = 8
const SUMMARY_CHARS = 2000
const TOOL_INPUT_CHARS = 200
const MAX_SCRIPT_BYTES = 1_000_000
const CODE_MODE_TOOL = "execute"

function defaultLogFile() {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "auto-mode.jsonl")
}

const plugin: Plugin.Plugin = {
  id: "auto-mode",
  async setup(ctx) {
    type SessionID = Parameters<typeof ctx.session.get>[0]["sessionID"]
    const options = resolveOptions(ctx.options)
    const logFile =
      ctx.options.logFile === false ? undefined : typeof ctx.options.logFile === "string" ? ctx.options.logFile : defaultLogFile()
    const logPrompt = ctx.options.logPrompt === true
    const streaks = new Map<string, number>()
    // Refused actions, with the newest user turn at the time: an identical retry is refused again until the user
    // says something new, so a second review cannot flip the answer.
    const refused = new Map<string, { latest: string; effect: Effect; message?: string }>()
    // Code-mode snippets (by tool call ID) that the reviewer allowed.
    const reviewedSnippets = new Set<string>()
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
    // Serialize writes per storage key so concurrent captures don't drop each other.
    const serialize = (key: string, write: () => Promise<void>) => {
      const next = (writes.get(key) ?? Promise.resolve()).then(async () => {
        try {
          await write()
        } catch (error) {
          void log({ key, warning: `failed to store: ${String(error)}` })
        }
      })
      writes.set(key, next)
      return next
    }
    const record = (sessionID: string, produce: () => Promise<Turn[]>) =>
      serialize(key(sessionID), async () => {
        const turns = await produce()
        if (!turns.length) return
        const merged = capTurns(mergeTurns(await loadTurns(sessionID), turns), STORED_TURNS)
        await ctx.storage.set(key(sessionID), merged as unknown as Parameters<typeof ctx.storage.set>[1])
      })
    const contextOf = async (sessionID: string) => {
      try {
        return (await ctx.session.context({ sessionID })) as unknown as ReadonlyArray<ContextMessage>
      } catch (error) {
        void log({ sessionID, warning: `session.context failed: ${String(error)}` })
        return []
      }
    }

    // Pin the instruction files in each session's system prompt at their first version (see instructions.ts).
    const pinned = new Map<string, Instruction[]>()
    const instructionKey = (sessionID: string) => `instructions/${sessionID}`
    const loadInstructions = async (sessionID: string) => {
      const cached = pinned.get(sessionID)
      if (cached) return cached
      try {
        const value = await ctx.storage.get(instructionKey(sessionID))
        const stored = Array.isArray(value) ? (value as unknown as Instruction[]) : []
        pinned.set(sessionID, stored)
        return stored
      } catch {
        return []
      }
    }
    if (options.maxInstructionChars > 0)
      await ctx.session.hook("context", (event) => {
        const current = extractInstructions(event.system.map((part) => part.text))
        if (!current.length) return
        void serialize(instructionKey(event.sessionID), async () => {
          const next = pinInstructions(await loadInstructions(event.sessionID), current)
          if (!next) return
          pinned.set(event.sessionID, next)
          await ctx.storage.set(instructionKey(event.sessionID), next as unknown as Parameters<typeof ctx.storage.set>[1])
        })
      })

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

    // Read the local scripts a shell command runs (and package.json scripts it invokes), within a character budget.
    const readScripts = async (commands: ReadonlyArray<string>, directory: string) => {
      const scripts: ScriptSource[] = []
      if (options.maxScriptChars <= 0) return scripts
      let budget = options.maxScriptChars
      const seen = new Set<string>()
      const add = (label: string, content: string) => {
        if (budget <= 0 || seen.has(label)) return
        seen.add(label)
        const clipped = clip(content, budget)
        budget -= clipped.length
        scripts.push({ path: label, content: clipped })
      }
      const readFile = async (file: string) => {
        const resolved = path.resolve(directory, file.replace(/^~(?=\/)/, os.homedir()))
        // Never copy secrets into the prompt, which may go to a hosted model.
        if (seen.has(resolved) || isSensitivePath(resolved)) return
        try {
          const info = await stat(resolved)
          if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return
          const content = await fsReadFile(resolved, "utf8")
          if (!content.includes("\0")) add(resolved, content)
        } catch {}
      }
      let packageScripts: Record<string, unknown> | undefined
      const visit = async (command: string, depth: number) => {
        const targets = scriptTargets(command)
        for (const file of targets.files) await readFile(file)
        if (!targets.packageScripts.length || depth > 0) return
        if (packageScripts === undefined) {
          try {
            const manifest = JSON.parse(await fsReadFile(path.join(directory, "package.json"), "utf8")) as { scripts?: unknown }
            packageScripts = typeof manifest.scripts === "object" && manifest.scripts ? (manifest.scripts as Record<string, unknown>) : {}
          } catch {
            packageScripts = {}
          }
        }
        for (const name of targets.packageScripts) {
          for (const entry of [`pre${name}`, name, `post${name}`]) {
            const body = packageScripts[entry]
            if (typeof body !== "string") continue
            add(`package.json#scripts.${entry}`, body)
            await visit(body, depth + 1)
          }
        }
      }
      for (const command of commands) await visit(command, 0)
      return scripts
    }

    // The user's side of the conversation, from the root session (subagents inherit the user's authorization).
    const userContext = async (sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"], messages: ReadonlyArray<ContextMessage>) => {
      let session: { parentID?: string; model?: ModelRef } | undefined
      try {
        session = (await ctx.session.get({ sessionID })) as typeof session
      } catch {}
      let rootID: string = sessionID
      let parentID = session?.parentID
      for (let depth = 0; parentID && depth < MAX_PARENT_DEPTH; depth++) {
        rootID = parentID
        try {
          parentID = ((await ctx.session.get({ sessionID: parentID as typeof sessionID })) as { parentID?: string }).parentID
        } catch {
          break
        }
      }
      const rootMessages = rootID === sessionID ? messages : await contextOf(rootID)
      await writes.get(key(rootID))
      const extract = { agentChars: options.agentContextChars, messageChars: options.maxMessageChars }
      const turns = mergeTurns(await loadTurns(rootID), turnsFromContext(rootMessages, extract))
      // Text the user wrote or replied to: where a destination must appear before the user has "seen" it.
      const seen = turns.flatMap((turn) =>
        turn.kind === "user" ? [turn.text, ...(turn.agent ? [turn.agent] : [])] : [turn.question, turn.answer],
      )
      return { session, rootID, rootMessages, turns, seen }
    }

    const evaluate = async (event: Request) => {
      const original = event.effect
      if (original === "deny" || options.skip.includes(event.action)) return
      // Calls made inside a code-mode snippet that was just reviewed and allowed are covered by that review.
      if (!event.codeMode && original === "allow" && event.source && reviewedSnippets.has(event.source.id)) return
      const review = event.codeMode ? options.reviewCode : shouldReview(event.action, original, options, event.resources)
      // Code mode can only be refused, never turned into a prompt.
      const policy = event.codeMode ? { ...options, escalation: "deny" as const } : options
      const watch = watchList(options)
      const network = mayUseNetwork(event.action) || isConfigEdit(event.action, event.resources, options)
      const gate = network && watch.length > 0 && options.onWatchedHost === "confirm"
      if (!review && !gate) return
      const started = Date.now()
      const base = { sessionID: event.sessionID, action: event.action, resources: event.resources, original }

      const decide = (effect: Effect, message: string | undefined, via: string, extra: Record<string, unknown> = {}) => {
        event.effect = effect
        event.message = message
        void log({ ...base, effect, via, message, ms: Date.now() - started, ...extra })
      }

      if (review && options.fastAllow && event.action === "shell" && isReadOnlyShell(event.resources)) {
        return decide("allow", undefined, "fast-path")
      }

      const messages = await contextOf(event.sessionID as SessionID)
      const source = event.source
      const origin = source
        ? messages.find((message) => message.id === source.messageID && message.type === "assistant")
        : undefined
      const call = source ? origin?.content?.find((item) => item.type === "tool" && item.id === source.id) : undefined
      const input = event.input ?? (call?.state && call.state.status !== "streaming" ? call.state.input : undefined)
      const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
      const workdir = [fields.workdir, fields.cwd, fields.directory].find((value) => typeof value === "string" && value)
      const directory = path.resolve(ctx.location.directory, (workdir as string | undefined) ?? ".")

      const scripts = event.action === "shell" ? await readScripts(event.resources, directory) : []
      const hosts = network
        ? extractHosts(
            [...event.resources, JSON.stringify(input ?? {}), JSON.stringify(event.metadata ?? {}), ...scripts.map((script) => script.content)].join("\n"),
            watch,
          )
        : []
      const watched = hosts.filter((host) => isWatched(host, watch))
      if (!review && !watched.length) return

      // An identical command is re-reviewed whenever a script it runs has changed.
      const digest = createHash("sha256").update(JSON.stringify(scripts)).digest("hex").slice(0, 16)
      const cacheKey = JSON.stringify([event.sessionID, event.action, event.resources, digest])
      const cached = allowed.get(cacheKey)
      if (review && cached !== undefined && Date.now() - cached < options.cacheMs) return decide("allow", undefined, "cache")

      const user = await userContext(event.sessionID as SessionID, messages)
      const hostNotes = describeHosts(hosts, watch, user.seen)
      const unseen = hostNotes.filter((note) => note.watched && !note.mentioned).map((note) => note.host)
      if (gate && unseen.length) {
        // Deterministic: a watched destination the user never saw is not left to the model's judgment.
        const outcome = escalate(
          `Auto-mode: this action contacts ${unseen.join(", ")}, a watched destination (China-based service or mirror) that the user has not named in this conversation. Do not substitute another unrequested host or mirror.`,
          policy,
        )
        return decide(outcome.effect, outcome.message, "watched-host", { hosts: unseen })
      }
      if (!review) return
      // A fetch of a page whose host the user named needs no model call.
      if (event.action === "webfetch" && hostNotes.length && hostNotes.every((note) => note.mentioned && !note.watched))
        return decide("allow", undefined, "user-host", { hosts })

      const latest = user.turns.at(-1)?.id ?? ""
      const previous = refused.get(cacheKey)
      if (previous && previous.latest === latest)
        return decide(
          previous.effect,
          `${previous.message ?? "Blocked by auto-mode safety review."} (Retrying the same action gets the same answer until the user says something new.)`,
          "repeat",
        )

      const selected = selectTurns(user.turns, options.userMessages, options.pinFirst)
      // A subagent's own system prompt loads the same files; prefer the root session's pinned copy.
      await writes.get(instructionKey(user.rootID))
      await writes.get(instructionKey(event.sessionID))
      const rootInstructions = options.maxInstructionChars > 0 ? await loadInstructions(user.rootID) : []
      const instructionSet =
        rootInstructions.length || user.rootID === event.sessionID || options.maxInstructionChars <= 0
          ? rootInstructions
          : await loadInstructions(event.sessionID)

      // Compaction dropped history we have no verbatim record of: show its summary, marked untrusted.
      const compaction = latestCompaction(user.rootMessages)
      const summary =
        compaction && !user.turns.some((turn) => turn.id < compaction.id) ? clip(compaction.summary, SUMMARY_CHARS) : undefined

      const parentInstructions =
        user.rootID === event.sessionID
          ? undefined
          : turnsFromContext(messages, { agentChars: 0, messageChars: options.maxMessageChars })
              .flatMap((turn) => (turn.kind === "user" ? [turn.text] : []))
              .slice(-2)

      // Review with the model that issued this tool call, so no other model has to be loaded.
      let model: ModelRef | undefined = origin?.model ?? user.session?.model
      if (model && options.variant) model = { ...model, variant: options.variant }

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
            tool: event.codeMode ? "execute (code mode: JavaScript with network access, run outside the permission system)" : call?.name,
            input,
            metadata: event.metadata,
            directory,
          },
          options.maxActionChars,
        ),
        hosts: hostNotes,
        scripts,
        extraRules: options.extraRules,
        instructions: renderInstructions(instructionSet, options.maxInstructionChars),
      })
      const shape = {
        turns: selected.turns.length,
        pinned: Boolean(selected.task),
        summary: Boolean(summary),
        subagent: user.rootID !== event.sessionID,
        promptChars: prompt.length,
        ...(instructionSet.length ? { instructions: instructionSet.map((item) => item.path) } : {}),
        ...(scripts.length ? { scripts: scripts.map((script) => script.path) } : {}),
        ...(hosts.length ? { hosts } : {}),
        ...(logPrompt ? { prompt } : {}),
      }

      // Same route OpenCode uses for chat: the server resolves provider, credentials and options for this model.
      // The in-process client does not reliably honor abort signals, so the deadline is enforced with a race.
      const controller = new AbortController()
      const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Infinity
      const generate = () => {
        const call = ctx.generate.text({ prompt, ...(model ? { model } : {}) }, { signal: controller.signal })
        if (deadline === Infinity) return call
        let timer: ReturnType<typeof setTimeout> | undefined
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error(`timed out after ${options.timeoutMs}ms`))
          }, Math.max(0, deadline - Date.now()))
        })
        return Promise.race([call, expired]).finally(() => clearTimeout(timer))
      }
      let text: string
      try {
        text = (
          await generate().catch(async (error) => {
            if (controller.signal.aborted) throw error
            await new Promise((resolve) => setTimeout(resolve, 1000))
            return generate()
          })
        ).text
      } catch (error) {
        const outcome = decideOutcome(undefined, 0, policy, `Auto-mode reviewer failed: ${String(error)}`)
        return decide(outcome.effect, outcome.message, "error", { model, ...shape })
      }

      const verdict = parseVerdict(text)
      if (!verdict) {
        const outcome = decideOutcome(undefined, 0, policy)
        return decide(outcome.effect, outcome.message, "unparseable", { model, ...shape, reply: text.slice(0, 500) })
      }

      const streak = verdict.decision === "block" ? (streaks.get(event.sessionID) ?? 0) + 1 : 0
      const outcome = decideOutcome(verdict, streak, policy)
      if (verdict.decision === "allow") {
        allowed.set(cacheKey, Date.now())
        refused.delete(cacheKey)
      } else if (outcome.effect !== "allow") {
        refused.set(cacheKey, { latest, effect: outcome.effect, message: outcome.message })
        if (refused.size > 500) refused.delete(refused.keys().next().value!)
      }
      // A streak ends on any non-block verdict, and once it has escalated.
      if (verdict.decision !== "block" || (options.maxConsecutiveBlocks > 0 && streak >= options.maxConsecutiveBlocks))
        streaks.delete(event.sessionID)
      else streaks.set(event.sessionID, streak)
      return decide(outcome.effect, outcome.message, "model", {
        model,
        ...shape,
        verdict: verdict.decision,
        reason: verdict.reason,
        ...(streak ? { streak } : {}),
      })
    }

    await ctx.permission.hook("evaluate", async (event) => {
      await evaluate(event as unknown as Request & typeof event)
    })

    // Code mode's execute tool runs JavaScript (fetch included) without any permission check, so the snippet is
    // reviewed before it runs. OpenCode awaits this hook and runs the input it leaves behind, so a blocked snippet
    // is replaced with one that throws the reason.
    if (options.reviewCode)
      await ctx.tool.hook("execute.before", async (event) => {
        if (event.tool !== CODE_MODE_TOOL) return
        const fields = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {}
        const code = typeof fields.code === "string" ? fields.code : JSON.stringify(event.input ?? {})
        const request: Request = {
          sessionID: event.sessionID,
          action: CODE_MODE_TOOL,
          resources: [code],
          source: { messageID: event.messageID, id: event.id },
          input: event.input,
          codeMode: true,
          effect: "allow",
        }
        try {
          await evaluate(request)
        } catch (error) {
          request.effect = "deny"
          request.message = `Auto-mode could not review this code: ${String(error)}`
        }
        if (request.effect === "allow") {
          reviewedSnippets.add(event.id)
          if (reviewedSnippets.size > 500) reviewedSnippets.delete(reviewedSnippets.values().next().value!)
          return
        }
        const reason = request.message ?? "Blocked by auto-mode safety review."
        event.input = { ...fields, code: `throw new Error(${JSON.stringify(reason)})` }
      })

    return () => {
      streaks.clear()
      allowed.clear()
      reviewedSnippets.clear()
      refused.clear()
    }
  },
}

export default plugin
