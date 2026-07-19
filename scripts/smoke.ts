const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_REASONING_MODEL = 'gpt-5.6-sol-high'

type Options = {
  readonly baseUrl: string
  readonly key: string
  readonly model: string
  readonly reasoningModel: string
}

type MutableOptions = {
  baseUrl: string
  key: string
  model: string
  reasoningModel: string
}

type Check = {
  readonly name: string
  readonly run: () => Promise<void>
}

class SmokeError extends Error {
  readonly name = 'SmokeError'
}

const HELP = `Usage: bun run scripts/smoke.ts [options]

Runs live end-to-end checks against a running kiro-provider gateway.

Options:
  --base-url <url>          Gateway URL (default: ${DEFAULT_BASE_URL})
  --key <key>               Bearer key (env: KIRO_PROVIDER_SMOKE_KEY)
  --model <id>              Claude model (default: ${DEFAULT_MODEL})
  --reasoning-model <id>    Effort model (default: ${DEFAULT_REASONING_MODEL})
  --help                    Show this help

Environment fallbacks:
  KIRO_PROVIDER_BASE_URL
  KIRO_PROVIDER_HOST (used with KIRO_PROVIDER_PORT)
  KIRO_PROVIDER_PORT
  KIRO_PROVIDER_SMOKE_KEY
  KIRO_PROVIDER_SMOKE_MODEL
  KIRO_PROVIDER_SMOKE_REASONING_MODEL`

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new SmokeError(`${label} must be an object`)
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SmokeError(`${label} must be a non-empty string`)
  }
  return value
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new SmokeError(`${flag} requires a value`)
  return value
}

type BaseUrlFlags = {
  readonly baseUrl?: string
}

export function resolveBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  flags: BaseUrlFlags
): string {
  const port = env.KIRO_PROVIDER_PORT
  const host = env.KIRO_PROVIDER_HOST ?? '127.0.0.1'
  const value = flags.baseUrl
    ?? env.KIRO_PROVIDER_BASE_URL
    ?? (port === undefined ? DEFAULT_BASE_URL : `http://${host}:${port}`)
  try {
    return new URL(value).toString().replace(/\/$/, '')
  } catch (error) {
    if (error instanceof TypeError) throw new SmokeError(`Invalid --base-url: ${value}`)
    throw error
  }
}

function parseOptions(args: readonly string[]): Options | null {
  if (args.includes('--help')) return null

  const options: MutableOptions = {
    baseUrl: '',
    key: process.env.KIRO_PROVIDER_SMOKE_KEY ?? '',
    model: process.env.KIRO_PROVIDER_SMOKE_MODEL ?? DEFAULT_MODEL,
    reasoningModel:
      process.env.KIRO_PROVIDER_SMOKE_REASONING_MODEL ?? DEFAULT_REASONING_MODEL
  }
  const targets: Readonly<Record<string, keyof MutableOptions>> = {
    '--base-url': 'baseUrl',
    '--key': 'key',
    '--model': 'model',
    '--reasoning-model': 'reasoningModel'
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) continue
    const equalsIndex = argument.indexOf('=')
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    const target = targets[flag]
    if (!target) throw new SmokeError(`Unknown option: ${flag}. Use --help for usage.`)
    const value = equalsIndex === -1
      ? readFlagValue(args, index, flag)
      : argument.slice(equalsIndex + 1)
    if (value.trim().length === 0) throw new SmokeError(`${flag} requires a non-empty value`)
    options[target] = value
    if (equalsIndex === -1) index += 1
  }

  if (options.key.trim().length === 0) {
    throw new SmokeError('Missing API key. Set KIRO_PROVIDER_SMOKE_KEY or pass --key.')
  }
  options.baseUrl = resolveBaseUrl(
    process.env,
    options.baseUrl.length === 0 ? {} : { baseUrl: options.baseUrl }
  )
  return options
}

function headers(key: string): Readonly<Record<string, string>> {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

async function requireSuccess(response: Response): Promise<void> {
  if (response.status === 200) return
  const detail = await response.text()
  throw new SmokeError(`HTTP ${response.status} ${response.statusText}: ${detail}`)
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  await requireSuccess(response)
  return response.json()
}

function chatBody(model: string, stream: boolean, reasoningEffort?: 'high'): string {
  return JSON.stringify({
    model,
    stream,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
  })
}

async function checkModels(options: Options): Promise<void> {
  const body = requireRecord(await requestJson(`${options.baseUrl}/v1/models`, {
    headers: headers(options.key)
  }), 'models response')
  if (body.object !== 'list') throw new SmokeError('models response object must be "list"')
  const data = body.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new SmokeError('models response data must be a non-empty array')
  }
  const ids = data.map((item, index) => {
    const model = requireRecord(item, `data[${index}]`)
    if (model.object !== 'model') throw new SmokeError(`data[${index}].object must be "model"`)
    return requireNonEmptyString(model.id, `data[${index}].id`)
  })
  console.log(`    Models (${ids.length}): ${ids.join(', ')}`)
}

function parseCompletion(body: unknown): Readonly<Record<string, unknown>> {
  const completion = requireRecord(body, 'completion response')
  if (completion.object !== 'chat.completion') {
    throw new SmokeError('completion response object must be "chat.completion"')
  }
  const choices = completion.choices
  if (!Array.isArray(choices) || !choices[0]) throw new SmokeError('completion has no first choice')
  return requireRecord(requireRecord(choices[0], 'choices[0]').message, 'choices[0].message')
}

async function checkNonStreaming(options: Options): Promise<void> {
  const body = await requestJson(`${options.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: headers(options.key), body: chatBody(options.model, false)
  })
  const content = requireNonEmptyString(parseCompletion(body).content, 'message.content')
  const usage = requireRecord(requireRecord(body, 'completion response').usage, 'usage')
  console.log(`    Content: ${JSON.stringify(content)}`)
  console.log(`    Usage: ${JSON.stringify(usage)}`)
}

function consumeSseFrame(frame: string, state: { content: string; chunks: number; done: number }): void {
  const lines = frame.split('\n').filter((line) => line.length > 0)
  if (lines.length !== 1 || !lines[0]?.startsWith('data: ')) {
    throw new SmokeError(`Malformed SSE frame: ${JSON.stringify(frame)}`)
  }
  const payload = lines[0].slice('data: '.length)
  if (payload === '[DONE]') {
    state.done += 1
    return
  }
  const parsed: unknown = JSON.parse(payload)
  const chunk = requireRecord(parsed, 'SSE chunk')
  if ('error' in chunk) throw new SmokeError(`SSE error frame: ${payload}`)
  if (chunk.object !== 'chat.completion.chunk') {
    throw new SmokeError('SSE chunk object must be "chat.completion.chunk"')
  }
  const choices = chunk.choices
  if (!Array.isArray(choices)) throw new SmokeError('SSE chunk choices must be an array')
  const first = choices[0]
  if (first) {
    const delta = requireRecord(requireRecord(first, 'SSE choice').delta, 'SSE delta')
    if (typeof delta.content === 'string') state.content += delta.content
  }
  state.chunks += 1
}

async function checkStreaming(options: Options): Promise<void> {
  const response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: headers(options.key), body: chatBody(options.model, true)
  })
  await requireSuccess(response)
  if (!response.body) throw new SmokeError('streaming response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const state = { content: '', chunks: 0, done: 0 }
  let buffer = ''
  while (true) {
    const result = await reader.read()
    buffer += decoder.decode(result.value, { stream: !result.done }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      consumeSseFrame(buffer.slice(0, boundary), state)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
    }
    if (result.done) break
  }
  if (buffer.trim().length > 0) throw new SmokeError(`Unterminated SSE frame: ${JSON.stringify(buffer)}`)
  if (state.chunks === 0) throw new SmokeError('stream returned no JSON chunks')
  if (state.done !== 1) throw new SmokeError(`expected exactly one [DONE], received ${state.done}`)
  requireNonEmptyString(state.content, 'assembled streaming content')
  console.log(`    Content (${state.chunks} chunks): ${JSON.stringify(state.content)}`)
}

async function checkReasoning(options: Options): Promise<void> {
  const body = await requestJson(`${options.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: headers(options.key),
    body: chatBody(options.reasoningModel, false, 'high')
  })
  const message = parseCompletion(body)
  const content = requireNonEmptyString(message.content, 'message.content')
  const reasoning = message.reasoning_content
  console.log('    Requested reasoning_effort: high')
  if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
    console.log(`    Reasoning: ${JSON.stringify(reasoning)}`)
  } else {
    console.log('    NOTE: model returned no reasoning_content')
  }
  console.log(`    Content: ${JSON.stringify(content)}`)
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2))
  if (!options) {
    console.log(HELP)
    return
  }
  console.log(`Kiro provider smoke test: ${options.baseUrl}`)
  console.log(`Models: chat=${options.model}, reasoning=${options.reasoningModel}`)
  const checks: readonly Check[] = [
    { name: 'GET /v1/models', run: () => checkModels(options) },
    { name: 'Non-streaming chat completion', run: () => checkNonStreaming(options) },
    { name: 'Streaming chat completion', run: () => checkStreaming(options) },
    { name: 'Thinking / effort chat completion', run: () => checkReasoning(options) }
  ]
  let passed = 0
  for (const [index, check] of checks.entries()) {
    console.log(`\n[${index + 1}/${checks.length}] ${check.name}`)
    try {
      await check.run()
      passed += 1
      console.log(`  PASS ${check.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  FAIL ${check.name}: ${message}`)
    }
  }
  console.log(`\nSummary: ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exitCode = 1
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`FAIL smoke setup: ${message}`)
    process.exitCode = 1
  })
}
