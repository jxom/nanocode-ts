import type { Store } from './Account.ts'
import * as Mcp from './Mcp.ts'

const serverName = 'gateway'
const root = 'kv:'
const valueBytes = 65_536
const ttlSeconds = 7_776_000
const pageSize = 100
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Entry = {
  expiresAt: number
  value: unknown
  version: number
}

type Arguments = {
  app?: unknown
  cursor?: unknown
  ifVersion?: unknown
  key?: unknown
  limit?: unknown
  owner?: unknown
  prefix?: unknown
  public?: unknown
  ttl?: unknown
  value?: unknown
}

type Call = {
  arguments: Arguments
  id: unknown
  name: string
}

type Answer = { data: unknown } | { error: string }

export function serve(
  store: Store,
  options: serve.Options,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined> {
  const gateway = options.servers.filter((server) => server.name === serverName)
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!gateway.length || !Mcp.server(url, gateway)) return undefined
    const body = init?.body
    const call = parse(
      typeof body === 'string'
        ? body
        : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
          ? decoder.decode(body)
          : undefined,
    )
    if (!call || call.arguments.owner !== undefined) return undefined
    const answer = await answerOf(store, call)
    if (!answer) return undefined
    return Response.json({
      id: call.id,
      jsonrpc: '2.0',
      result:
        'error' in answer
          ? { content: [{ text: answer.error, type: 'text' }], isError: true }
          : { content: [{ text: JSON.stringify(answer.data), type: 'text' }] },
    })
  }
}

export declare namespace serve {
  type Options = {
    servers: readonly Mcp.Server[]
  }
}

function parse(text: string | undefined): Call | undefined {
  const message = (() => {
    try {
      return JSON.parse(text ?? '') as {
        id?: unknown
        method?: unknown
        params?: { arguments?: unknown; name?: unknown }
      }
    } catch {
      return undefined
    }
  })()
  if (message?.method !== 'tools/call' || typeof message.params?.name !== 'string') return undefined
  const args = message.params.arguments
  return {
    arguments: typeof args === 'object' && args !== null ? (args as Arguments) : {},
    id: message.id ?? null,
    name: message.params.name,
  }
}

function view(key: string, entry: Entry) {
  return {
    expiresAt: new Date(entry.expiresAt).toISOString(),
    key,
    public: false,
    value: entry.value,
    version: entry.version,
  }
}

async function live(store: Store): Promise<[string, Entry][]> {
  const now = Date.now()
  const entries: [string, Entry][] = []
  for (const [path, stored] of await store.list<string>(root)) {
    const entry = JSON.parse(stored) as Entry
    if (entry.expiresAt > now) entries.push([path, entry])
    else await store.delete(path)
  }
  return entries
}

async function read(store: Store, path: string): Promise<Entry | undefined> {
  const stored = await store.get<string>(path)
  if (stored === undefined) return undefined
  const entry = JSON.parse(stored) as Entry
  if (entry.expiresAt > Date.now()) return entry
  await store.delete(path)
  return undefined
}

async function answerOf(store: Store, call: Call): Promise<Answer | undefined> {
  const args = call.arguments
  const app = args.app ?? 'default'
  if (typeof app !== 'string' || !app) return { error: 'app must be a non-empty string' }
  const scope = `${root}${app}:`
  if (call.name === 'kv_list') {
    const prefix = args.prefix ?? ''
    const limit = args.limit ?? pageSize
    const cursor = args.cursor
    if (typeof prefix !== 'string') return { error: 'prefix must be a string' }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > pageSize)
      return { error: `limit must be a whole number from 1 to ${pageSize}` }
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string')
      return { error: 'cursor must be a string' }
    const entries = (await live(store))
      .filter(([path]) => path.startsWith(scope + prefix))
      .map(([path, entry]) => [path.slice(scope.length), entry] as const)
      .filter(([key]) => typeof cursor !== 'string' || key > cursor)
      .sort(([left], [right]) => (left < right ? -1 : 1))
    const page = entries.slice(0, limit)
    const last = page.at(-1)
    return {
      data: {
        cursor: entries.length > limit && last ? last[0] : null,
        items: page.map(([key, entry]) => view(key, entry)),
      },
    }
  }
  if (call.name !== 'kv_get' && call.name !== 'kv_set' && call.name !== 'kv_delete')
    return undefined
  const key = args.key
  if (typeof key !== 'string' || !key) return { error: 'key must be a non-empty string' }
  const path = scope + key
  if (call.name === 'kv_get') {
    const entry = await read(store, path)
    return { data: entry ? view(key, entry) : null }
  }
  if (call.name === 'kv_delete') {
    const entry = await read(store, path)
    if (entry) await store.delete(path)
    return { data: { deleted: !!entry, key } }
  }
  if (args.public === true) return undefined
  if (!('value' in args)) return { error: 'value is required' }
  const ttl = args.ttl ?? ttlSeconds
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > ttlSeconds)
    return { error: `ttl must be a whole number of seconds from 1 to ${ttlSeconds}` }
  const ifVersion = args.ifVersion
  if (ifVersion !== undefined && ifVersion !== null && typeof ifVersion !== 'number')
    return { error: 'ifVersion must be null or a version number' }
  if (encoder.encode(JSON.stringify(args.value)).byteLength > valueBytes)
    return { error: `value is larger than ${valueBytes} bytes of JSON` }
  const current = await read(store, path)
  if (ifVersion === null && current)
    return { error: `version_conflict: ${key} exists at version ${current.version}` }
  if (typeof ifVersion === 'number' && current?.version !== ifVersion)
    return {
      error: `version_conflict: ${key} is at version ${current?.version ?? 'none'}, not ${ifVersion}`,
    }
  const entry: Entry = {
    expiresAt: Date.now() + ttl * 1000,
    value: args.value,
    version: (current?.version ?? 0) + 1,
  }
  await store.put(path, JSON.stringify(entry))
  return {
    data: {
      expiresAt: new Date(entry.expiresAt).toISOString(),
      key,
      public: false,
      version: entry.version,
    },
  }
}
