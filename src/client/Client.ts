import * as conversation from './actions/conversation.ts'
import * as file from './actions/file.ts'
import * as message from './actions/message.ts'
import * as Config from './Config.ts'
import type * as Conversation from './Conversation.ts'
import * as Instance from './internal/Instance.ts'
import type * as LiveEvent from './LiveEvent.ts'
import * as Message from './Message.ts'
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
  off: Listen<plugins>
  on: Listen<plugins>
  removeListener: Listen<plugins>
} & Plugin.Namespaces<plugins>

export type Events<plugins extends readonly Plugin.Plugin[] = readonly Plugin.Plugin[]> = {
  conversation: Conversation.State
  event: LiveEvent.LiveEvent
  message: readonly Message.Message[]
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

  const transport = options.transport({
    headers: () => Object.assign({}, ...plugins.map((plugin) => plugin.headers?.() ?? {})),
    storage,
  })

  const config = Config.create({
    apply: (event) => emit('event', event),
    history: { key: storage.key, storage },
    transport,
  })

  let snapshot = derive(config, undefined)

  config.subscribe(() => {
    const previous = snapshot
    snapshot = derive(config, previous)
    if (snapshot.messages !== previous.messages) emit('message', snapshot.messages)
    if (snapshot.state !== previous.state) emit('state', snapshot.state)
    if (snapshot.conversation !== previous.conversation) emit('conversation', snapshot.conversation)
  })

  const current = (name: PropertyKey): { value: unknown } | undefined => {
    if (name === 'conversation') return { value: snapshot.conversation }
    if (name === 'message') return { value: snapshot.messages }
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
    off,
    on,
    removeListener: off,
  } as unknown as Client<Plugin.Flatten<plugins>>

  Instance.register(client, {
    config,
    conversation: () => snapshot.conversation,
    messages: () => snapshot.messages,
  })

  for (const plugin of plugins) {
    const context: Plugin.Context = {
      emit: (state) => {
        states.set(plugin.id, state)
        emit(plugin.id, state)
      },
      getState: () => states.get(plugin.id),
      storage,
    }
    if (plugin.actions) Object.assign(client, { [plugin.id]: plugin.actions(context) })
    plugin.setup?.(context)
  }

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
