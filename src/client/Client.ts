import type * as Contracts from '../Contracts.ts'
import * as Keyring from '../machines/Keyring.ts'
import * as conversation from './actions/conversation.ts'
import * as file from './actions/file.ts'
import * as message from './actions/message.ts'
import * as model from './actions/model.ts'
import * as payer from './actions/payer.ts'
import * as Config from './Config.ts'
import * as Conversation from './Conversation.ts'
import * as Instance from './internal/Instance.ts'
import type * as LiveEvent from './LiveEvent.ts'
import * as Message from './Message.ts'
import * as Model from './Model.ts'
import * as Payer from './Payer.ts'
import * as Plugin from './Plugin.ts'
import * as Storage from './Storage.ts'
import * as Transcript from './Transcript.ts'
import type * as Transport from './Transport.ts'

export type Client<plugins extends readonly Plugin.Plugin[] = readonly Plugin.Plugin[]> = {
  addListener: Listen<plugins>
  conversation: {
    create(): string | undefined
    get(): Conversation.State
    remove(options: conversation.remove.Options): void
    select(options: conversation.select.Options): void
  }
  events<name extends keyof Events<plugins>>(
    name: name,
    options?: events.Options,
  ): AsyncGenerator<Events<plugins>[name], void, undefined>
  file: {
    get(): file.get.ReturnType
    read(options: file.read.Options): Promise<Blob>
    upload(options: file.upload.Options): Promise<Transport.Attachment>
  }
  getState(): State
  message: {
    list(): readonly Message.Message[]
    note(options: message.note.Options): void
    send(options: message.send.Options): Promise<void>
    stop(): Promise<void>
  }
  model: {
    get(): Model.State
    select(options: model.select.Options): void
    setThinking(options: model.setThinking.Options): void
  }
  off: Listen<plugins>
  on: Listen<plugins>
  payer: {
    get(): Payer.State
    select(options: payer.select.Options): void
  }
  removeListener: Listen<plugins>
} & Plugin.Namespaces<plugins>

export type Events<plugins extends readonly Plugin.Plugin[] = readonly Plugin.Plugin[]> = {
  conversation: Conversation.State
  event: LiveEvent.LiveEvent
  message: readonly Message.Message[]
  model: Model.State
  payer: Payer.State
  state: State
} & Plugin.States<plugins>

export type State =
  | { error: Error; status: 'error' }
  | { status: 'ready' }
  | { status: 'streaming' }
  | { status: 'submitted' }

type Listen<plugins extends readonly Plugin.Plugin[]> = <name extends keyof Events<plugins>>(
  name: name,
  listener: (value: Events<plugins>[name]) => void,
) => Client<plugins>

type Saved = {
  bound: Record<string, string>
  paid: Record<string, string>
  payer?: string | undefined
  picked?: string | undefined
  thinking?: Record<string, Contracts.Thinking> | undefined
}

type Snapshot = {
  conversation: Conversation.State
  entries: readonly Transcript.Entry[]
  live: readonly Transcript.Entry[]
  messages: readonly Message.Message[]
  pending: boolean
  state: State
}

export function create<const plugins extends readonly Plugin.Option[] = readonly []>(
  options: create.Options<plugins>,
): Client<Plugin.Flatten<plugins>> {
  const storage =
    options.storage ?? ('localStorage' in globalThis ? Storage.local() : Storage.memory())
  const plugins = Plugin.flatten(options.plugins ?? [])
  const listeners = new Map<PropertyKey, Set<(value: never) => void>>()
  const states = new Map<string, unknown>()

  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new Plugin.DuplicateError({ id: plugin.id })
    seen.add(plugin.id)
    if (plugin.initial !== undefined) states.set(plugin.id, plugin.initial)
  }

  const emit = (name: PropertyKey, value: unknown) => {
    for (const listener of [...(listeners.get(name) ?? [])])
      (listener as (value: unknown) => void)(value)
  }

  const savedKey = `${storage.key}:models`
  const saved: Saved = {
    bound: {},
    paid: {},
    ...(JSON.parse(storage.getItem(savedKey) ?? '{}') as Partial<Saved>),
  }
  let listing: Model.ListingState = { status: 'loading' }
  let selected: Model.State | undefined
  let paying: Payer.State | undefined

  const payers = (): Payer.State => {
    const deployment: Payer.Payer = {
      id: 'deployment',
      kind: 'deployment',
      label: 'This deployment',
      ...(listing.status === 'listed'
        ? { harnesses: listing.listing.harnesses, status: 'ready' as const }
        : listing),
    }
    const all = [
      deployment,
      ...plugins.flatMap(
        (plugin) => plugin.payers?.({ listing, state: states.get(plugin.id) }) ?? [],
      ),
    ]
    const id = config.getState().conversation
    const wanted = (id && saved.paid[id]) || saved.payer
    return { current: all.find((entry) => entry.id === wanted) ?? deployment, payers: all }
  }

  const resolve = (): Model.State => {
    const { current: paid } = paying!
    if (paid.status === 'loading') return { status: 'loading' }
    if (paid.status === 'failed')
      return {
        error:
          paid.error instanceof Model.ListError
            ? paid.error
            : new Model.ListError({ cause: paid.error, reason: paid.error.message }),
        status: 'failed',
      }
    if (paid.status === 'disconnected')
      return {
        error: new Model.ListError({ reason: `${paid.label} is not connected` }),
        status: 'failed',
      }
    const choices = paid.harnesses.flatMap((harness) =>
      harness.models.map((entry) => ({ entry, harness: harness.id })),
    )
    const id = config.getState().conversation
    const wanted = (id && saved.bound[id]) || saved.picked
    const found = choices.find((choice) => choice.entry.id === wanted) ?? choices[0]
    if (!found)
      return {
        error: new Model.ListError({ reason: `${paid.label} offers no models` }),
        status: 'failed',
      }
    return {
      current: found.entry,
      harness: found.harness,
      harnesses: paid.harnesses,
      status: 'ready',
      thinking:
        saved.thinking?.[found.entry.id] ??
        (found.entry.efforts.includes('low') ? 'low' : found.entry.effort),
    }
  }

  const ready = (): Extract<Model.State, { status: 'ready' }> => {
    const state = resolve()
    if (state.status !== 'ready') throw new Model.NotReadyError()
    return state
  }

  const persist = () => {
    const ids = new Set(config.getState().conversations.map((item) => item.id))
    saved.bound = Object.fromEntries(
      Object.entries(saved.bound).filter((entry) => ids.has(entry[0])),
    )
    saved.paid = Object.fromEntries(Object.entries(saved.paid).filter((entry) => ids.has(entry[0])))
    storage.setItem(savedKey, JSON.stringify(saved))
    refresh()
  }

  const headers = (): Record<string, string> =>
    Object.assign(
      Keyring.visitorHeaders({ storage }),
      ...plugins.map((plugin) => plugin.headers?.() ?? {}),
    )

  const rebind = (bound: Record<string, string>, id: string) => {
    const conversation = config.getState().conversation
    if (!conversation || !bound[conversation] || bound[conversation] === id) return
    if (snapshot.conversation.status === 'locked') throw new Conversation.LockedError()
    config.create()
  }

  const transport = options.transport({
    headers,
    selection: () => {
      const state = ready()
      return {
        harness: state.harness,
        model: state.current.id,
        payer: paying!.current.kind,
        thinking: state.thinking,
      }
    },
    session: {
      load: () => ({}),
      save: (session) => {
        const id = config.getState().conversation
        if (!session.id || !id || saved.bound[id]) return
        saved.bound[id] = ready().current.id
        saved.paid[id] = paying!.current.id
        persist()
      },
    },
    storage,
  })

  const config = Config.create({
    apply: (event) => emit('event', event),
    history: { key: storage.key, storage },
    transport,
  })

  const listed: Promise<void> = transport.models
    ? transport.models().then(
        (result) => {
          listing = { listing: result, status: 'listed' }
          refresh()
        },
        (cause: unknown) => {
          listing = {
            error: new Model.ListError({
              cause,
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
            status: 'failed',
          }
          refresh()
        },
      )
    : Promise.resolve()
  if (!transport.models)
    listing = {
      error: new Model.ListError({ reason: 'the transport lists no models' }),
      status: 'failed',
    }

  let snapshot = derive(config, undefined)
  paying = payers()
  selected = resolve()

  function refresh() {
    const previous = snapshot
    snapshot = derive(config, previous)
    if (snapshot.messages !== previous.messages) emit('message', snapshot.messages)
    if (snapshot.state !== previous.state) emit('state', snapshot.state)
    if (snapshot.conversation !== previous.conversation) emit('conversation', snapshot.conversation)
    const nextPayer = payers()
    if (!samePayer(paying, nextPayer)) {
      paying = nextPayer
      emit('payer', nextPayer)
    }
    const next = resolve()
    if (!same(selected, next)) {
      selected = next
      emit('model', next)
    }
  }

  config.subscribe(refresh)

  const current = (name: PropertyKey): { value: unknown } | undefined => {
    if (name === 'conversation') return { value: snapshot.conversation }
    if (name === 'message') return { value: snapshot.messages }
    if (name === 'model') return { value: selected }
    if (name === 'payer') return { value: paying }
    if (name === 'state') return { value: snapshot.state }
    if (typeof name === 'string' && states.has(name)) return { value: states.get(name) }
    return undefined
  }

  const on = (name: PropertyKey, listener: (value: never) => void) => {
    const set = listeners.get(name) ?? new Set()
    set.add(listener)
    listeners.set(name, set)
    return client
  }

  const off = (name: PropertyKey, listener: (value: never) => void) => {
    listeners.get(name)?.delete(listener)
    return client
  }

  async function* events(name: PropertyKey, options: events.Options = {}) {
    const { signal } = options
    const first = current(name)
    const queue: unknown[] = first ? [first.value] : []
    let wake: (() => void) | undefined
    const listener = (value: unknown) => {
      queue.push(value)
      wake?.()
    }
    const abort = () => wake?.()

    on(name, listener)
    signal?.addEventListener('abort', abort)
    try {
      while (!signal?.aborted) {
        if (queue.length) {
          yield queue.shift()
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = undefined
      }
    } finally {
      off(name, listener)
      signal?.removeEventListener('abort', abort)
    }
  }

  const client = {
    addListener: on,
    conversation: {
      create: () => conversation.create(client),
      get: () => conversation.get(client),
      remove: (options: conversation.remove.Options) => conversation.remove(client, options),
      select: (options: conversation.select.Options) => conversation.select(client, options),
    },
    events,
    file: {
      get: () => file.get(client),
      read: (options: file.read.Options) => file.read(client, options),
      upload: (options: file.upload.Options) => file.upload(client, options),
    },
    getState: () => snapshot.state,
    message: {
      list: () => message.list(client),
      note: (options: message.note.Options) => message.note(client, options),
      send: (options: message.send.Options) => message.send(client, options),
      stop: () => message.stop(client),
    },
    model: {
      get: () => model.get(client),
      select: (options: model.select.Options) => model.select(client, options),
      setThinking: (options: model.setThinking.Options) => model.setThinking(client, options),
    },
    off,
    on,
    payer: {
      get: () => payer.get(client),
      select: (options: payer.select.Options) => payer.select(client, options),
    },
    removeListener: off,
  } as unknown as Client<Plugin.Flatten<plugins>>

  Instance.register(client, {
    config,
    conversation: () => snapshot.conversation,
    current,
    messages: () => snapshot.messages,
    model: {
      get: () => selected!,
      select: (id) => {
        const state = ready()
        if (!state.harnesses.some((harness) => harness.models.some((entry) => entry.id === id)))
          throw new Model.NotFoundError({ id })
        rebind(saved.bound, id)
        saved.picked = id
        persist()
      },
      setThinking: (thinking) => {
        const { current } = ready()
        if (!current.efforts.includes(thinking))
          throw new Model.ThinkingError({ efforts: current.efforts, id: current.id, thinking })
        saved.picked = current.id
        saved.thinking = { ...saved.thinking, [current.id]: thinking }
        persist()
      },
    },
    payer: {
      get: () => paying!,
      select: (id) => {
        const found = paying!.payers.find((entry) => entry.id === id)
        if (!found)
          throw new Payer.NotFoundError({ id, ids: paying!.payers.map((entry) => entry.id) })
        if (found.status === 'disconnected') throw new Payer.DisconnectedError(found)
        rebind(saved.paid, id)
        saved.payer = id
        persist()
      },
    },
    ready: async () => {
      await listed
      while (selected!.status === 'loading')
        await new Promise<void>((resolve) => {
          const listener = (state: Model.State) => {
            if (state.status === 'loading') return
            off('model', listener)
            resolve()
          }
          on('model', listener)
        })
      if (
        selected!.status === 'failed' &&
        (paying!.current.kind !== 'deployment' || transport.models)
      )
        throw selected!.error
      for (const plugin of plugins) await plugin.beforeSend?.(contexts.get(plugin)!)
    },
  })

  const contexts = new Map<Plugin.Plugin, Plugin.Context>()
  for (const plugin of plugins) {
    const context: Plugin.Context = {
      client,
      emit: (state) => {
        states.set(plugin.id, state)
        emit(plugin.id, state)
        refresh()
      },
      getState: () => states.get(plugin.id),
      headers,
      storage,
      transport,
    }
    contexts.set(plugin, context)
    if (plugin.actions) Object.assign(client, { [plugin.id]: plugin.actions(context) })
  }
  for (const plugin of plugins) plugin.setup?.(contexts.get(plugin)!)

  return client
}

export declare namespace create {
  type Options<plugins extends readonly Plugin.Option[] = readonly Plugin.Option[]> = {
    plugins?: plugins | undefined
    storage?: Storage.Storage | undefined
    transport: Transport.Factory
  }

  type ErrorType = Plugin.DuplicateError
}

function same(previous: Model.State | undefined, next: Model.State): boolean {
  if (!previous || previous.status !== next.status) return false
  if (previous.status === 'ready' && next.status === 'ready')
    return (
      previous.current === next.current &&
      previous.harnesses === next.harnesses &&
      previous.thinking === next.thinking
    )
  if (previous.status === 'failed' && next.status === 'failed') return previous.error === next.error
  return true
}

function samePayer(previous: Payer.State | undefined, next: Payer.State): boolean {
  if (!previous || previous.current.id !== next.current.id) return false
  if (previous.payers.length !== next.payers.length) return false
  return previous.payers.every((entry, index) => {
    const other = next.payers[index]!
    if (entry.id !== other.id || entry.status !== other.status || entry.label !== other.label)
      return false
    if (entry.status === 'ready' && other.status === 'ready')
      return entry.harnesses === other.harnesses
    if (entry.status === 'failed' && other.status === 'failed') return entry.error === other.error
    return true
  })
}

export declare namespace events {
  type Options = {
    signal?: AbortSignal | undefined
  }
}

function derive(config: Config.Config, previous: Snapshot | undefined): Snapshot {
  const { conversation: id, conversations, entries, error, live, status } = config.getState()
  const pending = status === 'pending'

  const messages =
    previous &&
    previous.entries === entries &&
    previous.live === live &&
    previous.pending === pending
      ? previous.messages
      : Message.fromEntries(entries, { live, pending })

  const state = ((): State => {
    if (pending)
      return Transcript.activity(live, { pending }).phase === 'waiting'
        ? { status: 'submitted' }
        : { status: 'streaming' }
    if (error) return { error, status: 'error' }
    return { status: 'ready' }
  })()

  const locked = pending && !config.detachable
  const conversation: Conversation.State = {
    conversations,
    current: id!,
    status: locked ? 'locked' : 'ready',
  }

  return {
    conversation:
      previous &&
      previous.conversation.conversations === conversations &&
      previous.conversation.current === id &&
      previous.conversation.status === conversation.status
        ? previous.conversation
        : conversation,
    entries,
    live,
    messages,
    pending,
    state:
      previous &&
      previous.state.status === state.status &&
      (state.status !== 'error' ||
        (previous.state.status === 'error' && previous.state.error === state.error))
        ? previous.state
        : state,
  }
}
