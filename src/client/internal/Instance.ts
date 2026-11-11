import type * as Config from '../Config.ts'
import type * as Conversation from '../Conversation.ts'
import type * as Message from '../Message.ts'

export type Instance = {
  config: Config.Config
  conversation(): Conversation.State
  messages(): readonly Message.Message[]
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
