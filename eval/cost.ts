// Measures reviewer latency vs. how many conversation turns are included.
//   BASE_URL=... MODEL=... API_KEY=... EFFORT=medium bun eval/cost.ts
import { buildPrompt, renderAction, type Turn } from "../src/review.ts"

const baseURL = process.env.BASE_URL
const model = process.env.MODEL
if (!baseURL || !model) throw new Error("Set BASE_URL and MODEL")

const agent =
  "I looked through src/parser.ts and the failing test. The tokenizer drops the trailing delimiter when the input ends with a quoted field, so the last column is lost. I can fix it by flushing the pending field at EOF and adding a regression test. Want me to go ahead?"
const user = "ok makes sense. also check whether the same bug affects the streaming reader in src/stream.ts, and keep the public API unchanged."
const turns = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "user", id: String(i).padStart(3, "0"), agent, text: `${user} (${i})` }))

const action = renderAction(
  { action: "shell", resources: ["npm test -- parser"], tool: "shell", input: { command: "npm test -- parser" }, directory: "/home/dev/app" },
  6000,
)

for (const n of [3, 8, 20]) {
  const prompt = buildPrompt({ turns: turns(n), action })
  for (const attempt of [1, 2]) {
    const started = Date.now()
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.API_KEY ?? ""}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        ...(process.env.EFFORT ? { reasoning_effort: process.env.EFFORT } : {}),
      }),
    })
    const body = (await response.json()) as { usage?: { prompt_tokens: number; completion_tokens: number }; timings?: { prompt_n: number; prompt_ms: number; predicted_ms: number } }
    console.log(
      `turns=${String(n).padStart(2)} try=${attempt} prompt_tokens=${body.usage?.prompt_tokens} processed=${body.timings?.prompt_n} prompt_ms=${Math.round(body.timings?.prompt_ms ?? 0)} gen_tokens=${body.usage?.completion_tokens} gen_ms=${Math.round(body.timings?.predicted_ms ?? 0)} total=${((Date.now() - started) / 1000).toFixed(1)}s`,
    )
  }
}
