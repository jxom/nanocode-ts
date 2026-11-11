import type * as Contracts from '../../Contracts.ts'
import type * as Client from '../Client.ts'
import type * as Config from './Config.ts'
import type * as Conversation from '../Conversation.ts'
import type * as Message from '../Message.ts'
import type * as Model from '../Model.ts'
import type * as Payer from '../Payer.ts'

export type Instance = {
  config: Config.Config
  conversation(): Conversation.State
  current(name: PropertyKey): { value: unknown } | undefined
  messages(): readonly Message.Message[]
  model: {
    get(): Model.State
    select(id: string): void
    setThinking(thinking: Contracts.Thinking): void
  }
  payer: {
    get(): Payer.State
    select(id: string): void
  }
  ready(): Promise<void>
}

const instances = new WeakMap<Client.Client, Instance>()

export function get(client: Client.Client): Instance {
  const found = instances.get(client)
  if (!found) throw new UnknownClientError()
  return found
}

export function register(client: Client.Client, instance: Instance): void {
  instances.set(client, instance)
}

export class UnknownClientError extends Error {
  override readonly name = 'Client.UnknownClientError'

  constructor() {
    super('The value is not a nanocode client. Create one with Client.create().')
  }
}
