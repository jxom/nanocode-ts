import type * as Contracts from '../../Contracts.ts'
import type * as Config from '../Config.ts'
import type * as Conversation from '../Conversation.ts'
import type * as Message from '../Message.ts'
import type * as Model from '../Model.ts'

export type Instance = {
  config: Config.Config
  conversation(): Conversation.State
  messages(): readonly Message.Message[]
  model: {
    get(): Model.State
    select(id: string): void
    setThinking(thinking: Contracts.Thinking): void
  }
  ready(): Promise<void>
}

const instances = new WeakMap<object, Instance>()

export function get(client: object): Instance {
  const found = instances.get(client)
  if (!found) throw new UnknownClientError()
  return found
}

export function register(client: object, instance: Instance): void {
  instances.set(client, instance)
}

export class UnknownClientError extends Error {
  override readonly name = 'Client.UnknownClientError'

  constructor() {
    super('The value is not a nanocode client. Create one with Client.create().')
  }
}
