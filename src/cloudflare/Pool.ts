import { DurableObject } from 'cloudflare:workers'

export type Env = {
  SESSIONS: DurableObjectNamespace
  SESSION_LOCATION_HINT?: DurableObjectLocationHint
  SESSION_POOL_KEEPALIVE_MS: string
  SESSION_POOL_SIZE: string
}

export type ShardEnv = Env & {
  SESSION_POOL: DurableObjectNamespace<SessionPool>
}

export const holdHeader = 'x-nanocode-prestart-hold-ms'

export const objectHeader = 'x-nanocode-session-object'

type Claim = {
  id: string
  kind: 'bound' | 'named' | 'pooled'
  ready?: { at: number; pinged: number | undefined }
}

type Ready = { at: number; id: string; pinged: number | undefined }

type Bound = { id: string; kind: 'bound' | 'named' | 'offered' }

export class SessionPool extends DurableObject<Env> {
  private readonly ready: ReturnType<typeof readySet>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, id TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS ready (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS sealed (at INTEGER NOT NULL)',
    )
    this.ready = readySet(ctx, env)
  }

  async alarm(): Promise<void> {
    await this.ready.alarm()
  }

  async bind(key: string, offered: string | undefined): Promise<Bound> {
    const sql = this.ctx.storage.sql
    const bound = sql
      .exec<{ id: string }>('SELECT id FROM bindings WHERE key = ?', key)
      .toArray()[0]
    if (bound) return { id: bound.id, kind: 'bound' }

    const named = this.env.SESSIONS.idFromName(key).toString()
    const result = ((): Bound => {
      if (offered === undefined || !this.sealed()) return { id: named, kind: 'named' }
      if (sql.exec('SELECT 1 FROM legacy WHERE id = ?', named).toArray().length)
        return { id: named, kind: 'named' }
      return { id: offered, kind: 'offered' }
    })()
    sql.exec('INSERT INTO bindings (key, id) VALUES (?, ?)', key, result.id)
    return result
  }

  async forward(key: string, request: Request): Promise<Response> {
    const started = performance.now()
    const claim = this.claim(key)
    return fetchClaim(this.env, { claim, request, started, timing: [] })
  }

  async resolve(key: string): Promise<string> {
    return this.claim(key).id
  }

  async seal(ids: readonly string[]): Promise<number> {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) sql.exec('INSERT OR IGNORE INTO legacy (id) VALUES (?)', id)
      if (!this.sealed()) sql.exec('INSERT INTO sealed (at) VALUES (?)', Date.now())
    })

    await this.ready.refill()
    return this.ready.count()
  }

  async warm(): Promise<number> {
    await this.ready.refill()
    return this.ready.count()
  }

  private claim(key: string): Claim {
    const sql = this.ctx.storage.sql
    const bound = sql
      .exec<{ id: string }>('SELECT id FROM bindings WHERE key = ?', key)
      .toArray()[0]
    if (bound) return { id: bound.id, kind: 'bound' }

    const named = this.env.SESSIONS.idFromName(key).toString()
    const claim = ((): Claim => {
      if (!this.sealed()) return { id: named, kind: 'named' }
      if (sql.exec('SELECT 1 FROM legacy WHERE id = ?', named).toArray().length)
        return { id: named, kind: 'named' }
      const ready = this.ready.take()
      if (!ready) return { id: named, kind: 'named' }
      return { id: ready.id, kind: 'pooled', ready: { at: ready.at, pinged: ready.pinged } }
    })()
    sql.exec('INSERT INTO bindings (key, id) VALUES (?, ?)', key, claim.id)

    if (this.sealed()) this.ctx.waitUntil(this.ready.refill())
    return claim
  }

  private sealed(): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM sealed').toArray().length > 0
  }
}

export class SessionShard extends DurableObject<ShardEnv> {
  private readonly ready: ReturnType<typeof readySet>

  constructor(ctx: DurableObjectState, env: ShardEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ready (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID',
    )
    this.ready = readySet(ctx, env)
  }

  async alarm(): Promise<void> {
    await this.ready.alarm()
  }

  async forward(key: string, request: Request): Promise<Response> {
    const started = performance.now()
    const offered = this.ready.take()
    const bound = await this.env.SESSION_POOL.get(this.env.SESSION_POOL.idFromName('pool'), {
      locationHint: this.env.SESSION_LOCATION_HINT,
    }).bind(key, offered?.id)
    const bindMs = performance.now() - started
    if (offered && bound.kind !== 'offered') this.ready.put(offered)
    this.ctx.waitUntil(this.ready.refill())

    const claim = ((): Claim => {
      if (bound.kind === 'offered' && offered)
        return { id: bound.id, kind: 'pooled', ready: { at: offered.at, pinged: offered.pinged } }
      if (bound.kind === 'offered')
        throw new Error('the session pool bound an id it was not offered')
      return { id: bound.id, kind: bound.kind }
    })()
    return fetchClaim(this.env, {
      claim,
      request,
      started,
      timing: [`pool_bind;dur=${Math.round(bindMs)}`],
    })
  }
}

async function fetchClaim(env: Env, options: fetchClaim.Options): Promise<Response> {
  const claimed = performance.now()
  const claim = options.claim
  const response = await env.SESSIONS.get(env.SESSIONS.idFromString(claim.id), {
    locationHint: env.SESSION_LOCATION_HINT,
  }).fetch(options.request)
  const headers = new Headers(response.headers)
  headers.set(objectHeader, claim.id)
  headers.append(
    'server-timing',
    [
      `pool_claim;dur=${Math.round(claimed - options.started)};desc=${claim.kind}`,
      ...options.timing,
      `pool_object;dur=${Math.round(performance.now() - claimed)}`,
      ...(claim.ready
        ? [
            `pool_ready;dur=${Date.now() - claim.ready.at}`,
            ...(claim.ready.pinged === undefined
              ? []
              : [`pool_ping;dur=${Date.now() - claim.ready.pinged}`]),
          ]
        : []),
    ].join(', '),
  )
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

declare namespace fetchClaim {
  type Options = {
    claim: Claim
    request: Request
    started: number
    timing: readonly string[]
  }
}

function readySet(ctx: DurableObjectState, env: Env) {
  const pinged = new Map<string, number>()
  const sql = ctx.storage.sql
  let starting = 0

  async function start(id: string): Promise<boolean> {
    const response = await env.SESSIONS.get(env.SESSIONS.idFromString(id), {
      locationHint: env.SESSION_LOCATION_HINT,
    })
      .fetch('https://session.internal/internal/prestart', {
        headers: {
          [holdHeader]: String(
            positive(env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
          ),
        },
        method: 'POST',
      })
      .catch(() => undefined)
    await response?.body?.cancel()
    if (response?.status !== 204) return false
    pinged.set(id, Date.now())
    return true
  }

  function count(): number {
    return sql.exec('SELECT 1 FROM ready').toArray().length
  }

  async function refill(): Promise<void> {
    const size = positive(env.SESSION_POOL_SIZE, 'SESSION_POOL_SIZE')
    const ids = Array.from({ length: size - starting - count() }, () =>
      env.SESSIONS.newUniqueId().toString(),
    )
    starting += ids.length
    const started = await Promise.all(ids.map((id) => start(id))).finally(() => {
      starting -= ids.length
    })
    ids.forEach((id, index) => {
      if (started[index]) sql.exec('INSERT INTO ready (id, at) VALUES (?, ?)', id, Date.now())
    })
    if (ids.length > 0 && !started.some(Boolean))
      throw new Error('no pooled session object started')

    if ((await ctx.storage.getAlarm()) === null)
      await ctx.storage.setAlarm(
        Date.now() + positive(env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
      )
  }

  return {
    async alarm(): Promise<void> {
      const ready = sql
        .exec<{ id: string }>('SELECT id FROM ready')
        .toArray()
        .map((row) => row.id)
      const started = await Promise.all(ready.map((id) => start(id)))
      ready.forEach((id, index) => {
        if (!started[index]) sql.exec('DELETE FROM ready WHERE id = ?', id)
      })

      await refill()
      await ctx.storage.setAlarm(
        Date.now() + positive(env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
      )
    },
    count,
    put(ready: Ready): void {
      sql.exec('INSERT INTO ready (id, at) VALUES (?, ?)', ready.id, ready.at)
      if (ready.pinged !== undefined) pinged.set(ready.id, ready.pinged)
    },
    refill,
    take(): Ready | undefined {
      const ready = sql
        .exec<{ at: number; id: string }>('SELECT id, at FROM ready ORDER BY at LIMIT 1')
        .toArray()[0]
      if (!ready) return
      sql.exec('DELETE FROM ready WHERE id = ?', ready.id)
      const at = pinged.get(ready.id)
      pinged.delete(ready.id)
      return { at: ready.at, id: ready.id, pinged: at }
    },
  }
}

export function forward(
  namespace: DurableObjectNamespace<SessionPool>,
  options: forward.Options,
): Promise<Response> {
  return namespace
    .get(namespace.idFromName('pool'), { locationHint: options.locationHint })
    .forward(options.key, options.request)
}

export declare namespace forward {
  type Options = {
    key: string
    locationHint?: DurableObjectLocationHint | undefined
    request: Request
  }
}

export function forwardShard(
  namespace: DurableObjectNamespace<SessionShard>,
  options: forwardShard.Options,
): Promise<Response> {
  return namespace.get(namespace.idFromName(options.colo)).forward(options.key, options.request)
}

export declare namespace forwardShard {
  type Options = {
    colo: string
    key: string
    request: Request
  }
}

export function resolve(
  namespace: DurableObjectNamespace<SessionPool>,
  options: resolve.Options,
): Promise<string> {
  return namespace
    .get(namespace.idFromName('pool'), { locationHint: options.locationHint })
    .resolve(options.key)
}

export declare namespace resolve {
  type Options = {
    key: string
    locationHint?: DurableObjectLocationHint | undefined
  }
}

export function warm(
  namespace: DurableObjectNamespace<SessionPool>,
  options: warm.Options = {},
): Promise<number> {
  return namespace.get(namespace.idFromName('pool'), { locationHint: options.locationHint }).warm()
}

export declare namespace warm {
  type Options = {
    locationHint?: DurableObjectLocationHint | undefined
  }
}

function positive(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${name} must be a positive integer`)
  return number
}
