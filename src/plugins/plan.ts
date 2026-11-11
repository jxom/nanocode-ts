import type { ChatGpt, Claude } from 'nanocode-egress'
import type * as Model from '../client/Model.ts'
import type * as Payer from '../client/Payer.ts'
import * as Plans from '../client/Plans.ts'
import * as Plugin from '../client/Plugin.ts'

export function plan(options: plan.Options) {
  const { providers, url } = options
  const runtimes = new WeakMap<Plugin.Context<plan.State>, Runtime>()
  const offered = new Map<Plans.Provider, WeakMap<Model.Listing, readonly Model.Harness[]>>()

  const runtime = (context: Plugin.Context<plan.State>) => {
    const found = runtimes.get(context)
    if (found) return found
    const created: Runtime = { api: Plans.create({ headers: context.headers, url }) }
    runtimes.set(context, created)
    return created
  }

  const update = (context: Plugin.Context<plan.State>, next: plan.State) =>
    context.emit({ ...context.getState(), ...next })

  const settle = (context: Plugin.Context<plan.State>, status: Plans.Status) => {
    const known = context.getState()?.claude
    context.emit({
      ...(providers.includes('claude') ? { claude: claudeState(status.claude, known) } : {}),
      ...(providers.includes('codex') ? { codex: codexState(status.codex) } : {}),
    })
    poll(context, status.codex)
  }

  const poll = (context: Plugin.Context<plan.State>, status: ChatGpt.Status) => {
    const { api, timer } = runtime(context)
    clearTimeout(timer)
    if (!providers.includes('codex') || status.state !== 'pending') return
    runtime(context).timer = setTimeout(
      () =>
        void api.status().then(
          (next) => settle(context, next),
          (error: unknown) =>
            update(context, { codex: { error: failure(error), status: 'failed' } }),
        ),
      status.poll_after_ms,
    )
  }

  const harnesses = (provider: Plans.Provider, listing: Model.Listing) => {
    const cache = offered.get(provider) ?? new WeakMap()
    offered.set(provider, cache)
    const cached = cache.get(listing)
    if (cached) return cached
    const listed = listing.payers?.plan
    const found = (listed ?? listing.harnesses)
      .filter((harness) => harness.id === provider)
      .map((harness) =>
        listed
          ? harness
          : {
              ...harness,
              models: harness.models.filter((entry) => Plans.serves(provider, entry.id)),
            },
      )
      .filter((harness) => harness.models.length)
    cache.set(listing, found)
    return found
  }

  return Plugin.from({
    actions: (context: Plugin.Context<plan.State>) => ({
      async complete(options: { code: string }): Promise<void> {
        const status = await runtime(context).api.complete(options.code.trim())
        update(context, { claude: claudeState(status, undefined) })
      },
      getState: (): plan.State => context.getState() ?? {},
      async refresh(): Promise<void> {
        try {
          settle(context, await runtime(context).api.status())
        } catch (error) {
          const failed = { error: failure(error), status: 'failed' as const }
          context.emit(Object.fromEntries(providers.map((provider) => [provider, failed])))
          throw error
        }
      },
      async signIn(options: { provider: Plans.Provider }): Promise<void> {
        const { provider } = options
        try {
          const started = await runtime(context).api.signIn(provider)
          if (started.provider === 'claude')
            update(context, {
              claude: {
                expiresAt: started.expires_at,
                status: 'signingIn',
                url: started.authorization_url,
              },
            })
          else settle(context, { ...(await runtime(context).api.status()), codex: started.status })
        } catch (error) {
          const failed = { error: failure(error), status: 'failed' as const }
          update(context, provider === 'claude' ? { claude: failed } : { codex: failed })
          throw error
        }
      },
      async signOut(options: { provider: Plans.Provider }): Promise<void> {
        await runtime(context).api.signOut(options.provider)
        settle(context, await runtime(context).api.status())
      },
    }),
    id: 'plan',
    initial: Object.fromEntries(
      providers.map((provider) => [provider, { status: 'loading' }]),
    ) as plan.State,
    payers: ({ listing, state }) =>
      providers.map((provider): Payer.Payer => {
        const base = {
          id: `plan:${provider}`,
          kind: 'plan' as const,
          label: `${Plans.name(provider)} plan`,
        }
        const entry = state?.[provider]
        if (!entry || entry.status === 'loading') return { ...base, status: 'loading' }
        if (entry.status === 'failed') return { ...base, error: entry.error, status: 'failed' }
        if (entry.status !== 'signedIn') return { ...base, status: 'disconnected' }
        if (listing.status !== 'listed') return { ...base, ...listing }
        return { ...base, harnesses: harnesses(provider, listing.listing), status: 'ready' }
      }),
    setup: (context: Plugin.Context<plan.State>) => {
      void runtime(context)
        .api.status()
        .then(
          (status) => settle(context, status),
          (error: unknown) => {
            const failed = { error: failure(error), status: 'failed' as const }
            context.emit(Object.fromEntries(providers.map((provider) => [provider, failed])))
          },
        )
    },
  })
}

export declare namespace plan {
  type Claude =
    | Shared<Exclude<Claude.Status['state'], 'authenticated'>>
    | { expiresAt: number; status: 'signingIn'; url: string }

  type Codex =
    | Shared<Exclude<ChatGpt.Status['state'], 'authenticated' | 'pending'>>
    | { code: string; expiresAt: number; status: 'signingIn'; url: string }

  type Options = {
    providers: readonly Plans.Provider[]
    url: string
  }

  type State = {
    claude?: Claude | undefined
    codex?: Codex | undefined
  }

  type Shared<reason extends string> =
    | { error: Error; status: 'failed' }
    | { reason: reason; status: 'signedOut' }
    | { status: 'loading' }
    | { status: 'signedIn' }
}

type Runtime = {
  api: Plans.Client
  timer?: ReturnType<typeof setTimeout> | undefined
}

function claudeState(status: Claude.Status, known: plan.Claude | undefined): plan.Claude {
  if (status.state === 'authenticated') return { status: 'signedIn' }
  if (status.state === 'pending' && known?.status === 'signingIn') return known
  return { reason: status.state, status: 'signedOut' }
}

function codexState(status: ChatGpt.Status): plan.Codex {
  if (status.state === 'authenticated') return { status: 'signedIn' }
  if (status.state === 'pending')
    return {
      code: status.user_code,
      expiresAt: status.expires_at,
      status: 'signingIn',
      url: status.verification_url,
    }
  return { reason: status.state, status: 'signedOut' }
}

function failure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
