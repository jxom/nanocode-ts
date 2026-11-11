import * as Plugin from '../client/Plugin.ts'
import * as Relay from '../client/Relay.ts'
import type * as Transport from '../client/Transport.ts'

export function hand(options: hand.Options = {}) {
  const { install, poll = { connected: 20_000, pairing: 3000 }, tab } = options
  const runtimes = new WeakMap<Plugin.Context<hand.State>, Runtime>()

  const runtime = (context: Plugin.Context<hand.State>) => {
    const found = runtimes.get(context)
    if (found) return found
    const created: Runtime = { generation: 0 }
    runtimes.set(context, created)
    return created
  }

  const source = (transport: Transport.Transport) => {
    if (!('hand' in transport && 'hands' in transport)) throw new NoRelayError()
    return transport as Transport.Transport & Relay.Source
  }

  const stop = (context: Plugin.Context<hand.State>) => {
    const found = runtime(context)
    clearTimeout(found.timer)
    found.generation++
    return found.generation
  }

  const watch = (
    context: Plugin.Context<hand.State>,
    generation: number,
    commands: Relay.commands.ReturnType,
  ) => {
    const relay = source(context.transport)
    const found = runtime(context)
    const check = async () => {
      const listing = await (
        relay.listing ? relay.listing() : relay.hands().then((hands) => ({ hands, toolsOnly: [] }))
      ).catch(() => ({ hands: [], toolsOnly: [] }))
      if (found.generation !== generation) return
      const machines = listing.hands.length > 0
      context.emit(
        machines
          ? { ...commands, listing, status: 'connected', where: Relay.where(listing) }
          : { ...commands, status: 'pairing' },
      )
      found.timer = setTimeout(() => void check(), machines ? poll.connected : poll.pairing)
    }
    void check()
  }

  return Plugin.from({
    actions: (context: Plugin.Context<hand.State>) => ({
      async connect(): Promise<void> {
        const relay = source(context.transport)
        const generation = stop(context)
        try {
          const access = await relay.hand()
          if (runtime(context).generation !== generation) return
          if (!access) throw new NoSessionError()
          const commands = Relay.commands(access, { install, tab })
          context.emit({ ...commands, status: 'pairing' })
          watch(context, generation, commands)
        } catch (error) {
          context.emit({
            error: error instanceof Error ? error : new Error(String(error)),
            status: 'failed',
          })
          throw error
        }
      },
      disconnect(): void {
        stop(context)
        context.emit({ status: 'disconnected' })
      },
      getState: (): hand.State => context.getState()!,
    }),
    id: 'hand',
    initial: { status: 'disconnected' } as hand.State,
    setup: (context: Plugin.Context<hand.State>) => {
      let current = context.client.conversation.get().current
      context.client.on('conversation', (state) => {
        if (state.current === current) return
        current = state.current
        stop(context)
        if (context.getState()?.status !== 'disconnected') context.emit({ status: 'disconnected' })
      })
    },
  })
}

export declare namespace hand {
  var SessionError: typeof NoSessionError
  var UnsupportedError: typeof NoRelayError

  type Commands = Relay.commands.ReturnType

  type Options = {
    install?: string | undefined
    poll?: { connected: number; pairing: number } | undefined
    tab?: string | false | undefined
  }

  type State =
    | (Commands & { listing: Relay.Listing; status: 'connected'; where: string })
    | (Commands & { status: 'pairing' })
    | { error: Error; status: 'failed' }
    | { status: 'disconnected' }
}

type Runtime = {
  generation: number
  timer?: ReturnType<typeof setTimeout> | undefined
}

class NoSessionError extends Error {
  override readonly name = 'hand.SessionError'

  constructor() {
    super('This session cannot take a machine. Start a new conversation.')
  }
}

class NoRelayError extends Error {
  override readonly name = 'hand.UnsupportedError'

  constructor() {
    super('The transport cannot connect a machine. Use the cloudflare or vercel transport.')
  }
}

hand.SessionError = NoSessionError
hand.UnsupportedError = NoRelayError
