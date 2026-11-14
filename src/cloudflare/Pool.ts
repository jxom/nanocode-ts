import { DurableObject } from 'cloudflare:workers'

export type Env = {
  SESSIONS: DurableObjectNamespace
  SESSION_LOCATION_HINT?: DurableObjectLocationHint
  SESSION_POOL_HEDGE_MS?: string
  SESSION_POOL_KEEPALIVE_MS: string
  SESSION_POOL_SIZE: string
}

export const hedgeHeader = 'x-nanocode-hedge'

export const holdHeader = 'x-nanocode-prestart-hold-ms'

export const objectHeader = 'x-nanocode-session-object'

type Claim = {
  id: string
  kind: 'bound' | 'named' | 'pooled'
  ready?: { at: number; pinged: number | undefined }
}

type Answer = { id: string; response: Response }

type Ready = { at: number; id: string; pinged: number | undefined }

export class SessionPool extends DurableObject<Env> {
  private readonly hedging = new Map<string, Promise<unknown>>()
  private readonly pinged = new Map<string, number>()
  private starting = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, id TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS ready (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS sealed (at INTEGER NOT NULL)',
    )
  }

  async alarm(): Promise<void> {
    const ready = this.ctx.storage.sql
      .exec<{ id: string }>('SELECT id FROM ready')
      .toArray()
      .map((row) => row.id)
    const started = await Promise.all(ready.map((id) => this.start(id)))
    ready.forEach((id, index) => {
      if (!started[index]) this.ctx.storage.sql.exec('DELETE FROM ready WHERE id = ?', id)
    })

    await this.refill()
    await this.ctx.storage.setAlarm(
      Date.now() + positive(this.env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
    )
  }

  async bound(key: string, id: string): Promise<boolean> {
    await this.hedging.get(key)?.catch(() => undefined)
    return (
      this.ctx.storage.sql
        .exec<{ id: string }>('SELECT id FROM bindings WHERE key = ?', key)
        .toArray()[0]?.id === id
    )
  }

  async forward(key: string, request: Request): Promise<Response> {
    const started = performance.now()
    await this.hedging.get(key)?.catch(() => undefined)
    const claim = this.claim(key)
    const claimed = performance.now()
    const answer =
      claim.kind === 'pooled' &&
      this.env.SESSION_POOL_HEDGE_MS !== undefined &&
      request.method === 'POST' &&
      new URL(request.url).pathname === '/internal/turns'
        ? await this.hedge(key, claim.id, request)
        : { id: claim.id, response: await this.object(claim.id).fetch(request) }
    const response = answer.response
    const headers = new Headers(response.headers)
    headers.set(objectHeader, answer.id)
    headers.append(
      'server-timing',
      [
        `pool_claim;dur=${Math.round(claimed - started)};desc=${claim.kind}`,
        `pool_object;dur=${Math.round(performance.now() - claimed)}`,
        ...(answer.id === claim.id ? [] : [`pool_hedge;desc=${answer.id}`]),
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

  async resolve(key: string): Promise<string> {
    await this.hedging.get(key)?.catch(() => undefined)
    return this.claim(key).id
  }

  async seal(ids: readonly string[]): Promise<number> {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) sql.exec('INSERT OR IGNORE INTO legacy (id) VALUES (?)', id)
      if (!this.sealed()) sql.exec('INSERT INTO sealed (at) VALUES (?)', Date.now())
    })

    await this.refill()
    return sql.exec('SELECT 1 FROM ready').toArray().length
  }

  async warm(): Promise<number> {
    await this.refill()
    return this.ctx.storage.sql.exec('SELECT 1 FROM ready').toArray().length
  }

  private async refill(): Promise<void> {
    const size = positive(this.env.SESSION_POOL_SIZE, 'SESSION_POOL_SIZE')
    const sql = this.ctx.storage.sql
    const ids = Array.from(
      { length: size - this.starting - sql.exec('SELECT 1 FROM ready').toArray().length },
      () => this.env.SESSIONS.newUniqueId().toString(),
    )
    this.starting += ids.length
    const started = await Promise.all(ids.map((id) => this.start(id))).finally(() => {
      this.starting -= ids.length
    })
    ids.forEach((id, index) => {
      if (started[index]) sql.exec('INSERT INTO ready (id, at) VALUES (?, ?)', id, Date.now())
    })
    if (ids.length > 0 && !started.some(Boolean))
      throw new Error('no pooled session object started')

    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(
        Date.now() + positive(this.env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
      )
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
      const ready = this.take()
      if (!ready) return { id: named, kind: 'named' }
      return { id: ready.id, kind: 'pooled', ready: { at: ready.at, pinged: ready.pinged } }
    })()
    sql.exec('INSERT INTO bindings (key, id) VALUES (?, ?)', key, claim.id)

    if (this.sealed()) this.ctx.waitUntil(this.refill())
    return claim
  }

  private async hedge(key: string, first: string, request: Request): Promise<Answer> {
    const body = await request.arrayBuffer()
    const headers = new Headers(request.headers)
    headers.set(hedgeHeader, encodeURIComponent(key))
    const send = (id: string): Promise<Answer> =>
      this.object(id)
        .fetch(
          new Request(request.url, { body, headers, method: request.method, redirect: 'manual' }),
        )
        .then((response) => ({ id, response }))
    const attempts = [send(first)]
    const decided = (async (): Promise<Answer> => {
      const early = await Promise.race([
        attempts[0]!,
        new Promise<undefined>((resolve) =>
          setTimeout(resolve, positive(this.env.SESSION_POOL_HEDGE_MS!, 'SESSION_POOL_HEDGE_MS')),
        ),
      ])
      if (early) return early
      const second = this.take()
      if (!second) return await attempts[0]!
      this.ctx.waitUntil(this.refill())
      attempts.push(send(second.id))
      const winner = await Promise.any(attempts)
      if (winner.id !== first)
        this.ctx.storage.sql.exec('UPDATE bindings SET id = ? WHERE key = ?', winner.id, key)
      return winner
    })()
    this.hedging.set(key, decided)
    const winner = await decided.finally(() => this.hedging.delete(key))
    this.ctx.waitUntil(this.verdict(winner.id, 'won'))
    for (const attempt of attempts)
      this.ctx.waitUntil(
        attempt.then(
          async (answer) => {
            if (answer.id === winner.id) return
            await answer.response.body?.cancel()
            await this.verdict(answer.id, 'lost')
          },
          () => undefined,
        ),
      )
    return winner
  }

  private object(id: string): DurableObjectStub {
    return this.env.SESSIONS.get(this.env.SESSIONS.idFromString(id), {
      locationHint: this.env.SESSION_LOCATION_HINT,
    })
  }

  private sealed(): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM sealed').toArray().length > 0
  }

  private take(): Ready | undefined {
    const sql = this.ctx.storage.sql
    const ready = sql
      .exec<{ at: number; id: string }>('SELECT id, at FROM ready ORDER BY at LIMIT 1')
      .toArray()[0]
    if (!ready) return
    sql.exec('DELETE FROM ready WHERE id = ?', ready.id)
    const pinged = this.pinged.get(ready.id)
    this.pinged.delete(ready.id)
    return { at: ready.at, id: ready.id, pinged }
  }

  private async verdict(id: string, verdict: 'lost' | 'won'): Promise<void> {
    const response = await this.object(id)
      .fetch('https://session.internal/internal/hedge', {
        headers: { [hedgeHeader]: verdict },
        method: 'POST',
      })
      .catch(() => undefined)
    await response?.body?.cancel()
  }

  private async start(id: string): Promise<boolean> {
    const response = await this.env.SESSIONS.get(this.env.SESSIONS.idFromString(id), {
      locationHint: this.env.SESSION_LOCATION_HINT,
    })
      .fetch('https://session.internal/internal/prestart', {
        headers: {
          [holdHeader]: String(
            positive(this.env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
          ),
        },
        method: 'POST',
      })
      .catch(() => undefined)
    await response?.body?.cancel()
    if (response?.status !== 204) return false
    this.pinged.set(id, Date.now())
    return true
  }
}

export function bound(
  namespace: DurableObjectNamespace<SessionPool>,
  options: bound.Options,
): Promise<boolean> {
  return namespace
    .get(namespace.idFromName('pool'), { locationHint: options.locationHint })
    .bound(options.key, options.id)
}

export declare namespace bound {
  type Options = {
    id: string
    key: string
    locationHint?: DurableObjectLocationHint | undefined
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
