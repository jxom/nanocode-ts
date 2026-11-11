import type * as Client from './Client.ts'
import type * as Model from './Model.ts'
import type * as Payer from './Payer.ts'
import type * as Storage from './Storage.ts'
import type * as Transport from './Transport.ts'

export type Plugin<id extends string = string, actions = unknown, state = unknown> = {
  actions?: ((context: Context<state>) => actions) | undefined
  beforeSend?: ((context: Context<state>) => Promise<void> | void) | undefined
  headers?: (() => Record<string, string>) | undefined
  id: id
  initial?: state | undefined
  payers?: ((options: PayersOptions<state>) => readonly Payer.Payer[]) | undefined
  setup?: ((context: Context<state>) => void) | undefined
}

export type Context<state = unknown> = {
  client: Client.Client
  emit(state: state): void
  getState(): state | undefined
  headers(): Record<string, string>
  storage: Storage.Storage
  transport: Transport.Transport
}

export type PayersOptions<state = unknown> = {
  listing: Model.ListingState
  state: state | undefined
}

export type Option = Plugin | false | null | undefined | readonly Option[]

export type Flatten<options extends readonly unknown[]> = options extends readonly []
  ? readonly []
  : options extends readonly [infer head, ...infer tail]
    ? readonly [
        ...(head extends readonly unknown[]
          ? Flatten<head>
          : head extends Plugin
            ? readonly [head]
            : readonly []),
        ...Flatten<tail>,
      ]
    : options extends readonly (infer entry)[]
      ? readonly Extract<entry, Plugin>[]
      : readonly []

export type Namespaces<plugins extends readonly Plugin[]> = {
  [plugin in plugins[number] as unknown extends ActionsOf<plugin>
    ? never
    : plugin['id']]: ActionsOf<plugin>
}

export type States<plugins extends readonly Plugin[]> = {
  [plugin in plugins[number] as unknown extends StateOf<plugin>
    ? never
    : plugin['id']]: StateOf<plugin>
}

type ActionsOf<plugin> = plugin extends Plugin<string, infer actions> ? actions : never

type StateOf<plugin> = plugin extends Plugin<string, unknown, infer state> ? state : never

export function flatten(options: readonly Option[]): readonly Plugin[] {
  return options.flatMap((option): readonly Plugin[] => {
    if (!option) return []
    if (Array.isArray(option)) return flatten(option as readonly Option[])
    return [option as Plugin]
  })
}

export function from<const id extends string, actions = unknown, state = unknown>(
  plugin: Plugin<id, actions, state>,
): Plugin<id, actions, state> {
  return plugin
}

export class DuplicateError extends Error {
  override readonly name = 'Plugin.DuplicateError'

  constructor(options: { id: string }) {
    super(`Two plugins use the ID "${options.id}". Pass each plugin once.`)
  }
}
