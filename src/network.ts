// Pure helpers for spotting where an action sends data and which local scripts it runs.
// No OpenCode runtime imports or file IO so this file can be unit-tested in isolation.

/**
 * Built-in watched destinations: China-based services and mirrors. Models (Qwen in particular) sometimes
 * produce these URLs unprompted, such as Aliyun or Tsinghua package mirrors, or Alibaba Cloud endpoints.
 * Entries match the host itself and any subdomain. Bare TLD entries ("cn") match every host under them.
 */
export const builtinWatchHosts = [
  "cn",
  "xn--fiqs8s", // .中国
  "xn--fiqz9s", // .中國
  "alibaba.com",
  "alibabacloud.com",
  "alibaba-inc.com",
  "aliyun.com",
  "aliyuncs.com",
  "alicdn.com",
  "alipay.com",
  "taobao.com",
  "tmall.com",
  "dingtalk.com",
  "qwen.ai",
  "qwenlm.ai",
  "modelscope.ai",
  "baidu.com",
  "baidubce.com",
  "bcebos.com",
  "qq.com",
  "tencent.com",
  "tencentcloud.com",
  "tencentcloudapi.com",
  "myqcloud.com",
  "weixin.com",
  "wechat.com",
  "bytedance.com",
  "byteimg.com",
  "volces.com",
  "volcengine.com",
  "larksuite.com",
  "huawei.com",
  "huaweicloud.com",
  "myhuaweicloud.com",
  "gitee.com",
  "gitcode.com",
  "npmmirror.com",
  "douban.com",
  "163.com",
  "126.com",
  "weibo.com",
  "csdn.net",
  "jd.com",
  "kuaishou.com",
  "xiaomi.com",
  "deepseek.com",
  "moonshot.ai",
  "kimi.com",
  "minimaxi.com",
]

// Second-level suffixes under which the registrable name is one label further left (mirrors.tuna.tsinghua.edu.cn → tsinghua.edu.cn).
const secondLevel = new Set(["com", "net", "org", "edu", "gov", "ac", "co"])

function normalize(host: string) {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
}

/** The registrable part of a host, e.g. mirrors.aliyun.com → aliyun.com. IPs are returned unchanged. */
export function siteOf(host: string) {
  const labels = normalize(host).split(".")
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1)!)) return labels.join(".")
  const count = secondLevel.has(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2
  return labels.slice(-count).join(".")
}

export function isWatched(host: string, watch: ReadonlyArray<string>) {
  const name = normalize(host)
  return watch.some((entry) => {
    const suffix = normalize(entry).replace(/^\*?\./, "")
    return suffix !== "" && (name === suffix || name.endsWith(`.${suffix}`))
  })
}

const urlHost = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"`<>]+@)?(\[[0-9a-f:]+\]|[a-z0-9.-]+)/gi
// user@host: as used by scp, rsync, ssh and git remotes.
const userHost = /(?:^|[\s'"=])[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[:\s'"]|$)/gim
const ipv4 = /(?<![\w.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\w.])/g
const bareDomain = /(?<![\w.@/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]+))(?![\w-])/gi
// Bare domains count as hosts only with a TLD that rarely collides with code or file names (not .sh, .py, .info, .app).
const commonTlds = new Set(["com", "net", "org", "io", "dev", "ai", "xyz", "cloud"])

/**
 * Hosts an action may contact: URL hosts, user@host targets, IPv4 literals, bare domains with a common TLD, and
 * any bare domain matching the watch list. Loopback and private-range hosts are left out.
 */
export function extractHosts(text: string, watch: ReadonlyArray<string> = []) {
  const found = new Set<string>()
  const add = (host: string | undefined) => {
    if (!host) return
    const name = normalize(host)
    if (!name.includes(".") && !name.includes(":")) return
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(name)) return
    if (name === "[::1]" || name === "::1" || name.endsWith(".local") || name.endsWith(".localhost")) return
    found.add(name)
  }
  for (const match of text.matchAll(urlHost)) add(match[1])
  for (const match of text.matchAll(userHost)) add(match[1])
  for (const match of text.matchAll(ipv4)) add(match[1])
  for (const match of text.matchAll(bareDomain)) {
    const name = normalize(match[1]!)
    if (commonTlds.has(name.split(".").at(-1)!) || isWatched(name, watch)) add(name)
  }
  return [...found]
}

/**
 * Whether the user has seen this destination in the conversation: the host, its registrable site, or the site's
 * name (aliyun for mirrors.aliyun.com) appears in text the user wrote or replied to.
 */
export function isMentioned(host: string, texts: ReadonlyArray<string>) {
  const name = normalize(host)
  const site = siteOf(name)
  const label = site.split(".")[0]!
  const word = label.length >= 4 && !/^\d+$/.test(label) ? new RegExp(`(^|[^a-z0-9-])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i") : undefined
  return texts.some((text) => {
    const lower = text.toLowerCase()
    return lower.includes(name) || lower.includes(site) || (word?.test(lower) ?? false)
  })
}

export interface HostNote {
  host: string
  watched: boolean
  mentioned: boolean
}

export function describeHosts(hosts: ReadonlyArray<string>, watch: ReadonlyArray<string>, texts: ReadonlyArray<string>): HostNote[] {
  return hosts.map((host) => ({ host, watched: isWatched(host, watch), mentioned: isMentioned(host, texts) }))
}

export function renderHosts(notes: ReadonlyArray<HostNote>) {
  return notes
    .map(
      (note) =>
        `- ${note.host}: ${note.mentioned ? "named in the conversation" : "NOT named by the user or in anything the user replied to"}${note.watched ? "; WATCHED destination (China-based service or mirror)" : ""}`,
    )
    .join("\n")
}

// Interpreters and runners whose file arguments are scripts worth showing to the reviewer.
const interpreter =
  /^(python[\d.]*|pypy[\d.]*|node|nodejs|bun|deno|tsx|ts-node|ruby|perl|php|bash|sh|zsh|dash|ksh|fish|pwsh|powershell|osascript|rscript|lua|luajit|go|java|groovy|kotlin|swift|elixir|source|\.)$/i
// Wrappers that run whatever follows them.
const wrapper = /^(sudo|env|time|nice|nohup|exec|command|uv|uvx|poetry|pipenv|pdm|hatch|rye|npx|bunx|pnpx|xargs|timeout|caffeinate|watch)$/i
const wrapperSubcommand = /^(run|exec|dlx|x)$/i
const scriptExtension = /\.(py|pyw|js|mjs|cjs|ts|mts|cts|jsx|tsx|sh|bash|zsh|fish|rb|pl|php|ps1|lua|r|go|java|kts|groovy|swift|exs?|applescript|scpt)$/i
const packageManager = /^(npm|pnpm|yarn|bun)$/i
const lifecycle = new Set(["test", "start", "stop", "restart"])

/** Split a shell segment into words, honoring simple quotes. Good enough to find file arguments. */
export function shellWords(segment: string) {
  const words: string[] = []
  for (const match of segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]!)
  return words
}

export interface ScriptTargets {
  /** Local files the command executes, as written (relative paths resolve against the working directory). */
  files: string[]
  /** package.json script names run through npm, pnpm, yarn or bun. */
  packageScripts: string[]
}

/** Find local scripts a shell command runs: interpreter file arguments, ./paths, and package.json scripts. */
export function scriptTargets(command: string): ScriptTargets {
  const files = new Set<string>()
  const packageScripts = new Set<string>()
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = shellWords(segment.trim()).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    let index = 0
    while (index < words.length) {
      const word = words[index]!
      const base = word.split("/").at(-1)!
      if (wrapper.test(base)) {
        index++
        while (index < words.length && (words[index]!.startsWith("-") || wrapperSubcommand.test(words[index]!))) index++
        continue
      }
      if (packageManager.test(base)) {
        const rest = words.slice(index + 1).filter((item) => !item.startsWith("-"))
        const name = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0]
        if (name && (lifecycle.has(name) || rest[0] === "run" || rest[0] === "run-script" || /^(pnpm|yarn|bun)$/i.test(base)))
          packageScripts.add(name)
        break
      }
      if (interpreter.test(base)) {
        const args = words.slice(index + 1)
        if (args.some((arg) => arg === "-c" || arg === "-e" || arg === "--eval")) break
        const file = args.find((arg) => !arg.startsWith("-") && arg !== "run" && (scriptExtension.test(arg) || arg.includes("/")))
        if (file) files.add(file)
        break
      }
      if (/^(\.{1,2}\/|\/|~\/)/.test(word) || scriptExtension.test(word)) files.add(word)
      break
    }
  }
  return { files: [...files], packageScripts: [...packageScripts] }
}

export interface ScriptSource {
  /** Path as resolved, or `package.json#scripts.<name>`. */
  path: string
  content: string
}

export function renderScripts(scripts: ReadonlyArray<ScriptSource>) {
  return scripts.map((script) => `<script path="${script.path}">\n${script.content}\n</script>`).join("\n")
}
