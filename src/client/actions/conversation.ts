import type * as Client from '../Client.ts'
import * as Conversation from '../Conversation.ts'
import * as Instance from '../internal/Instance.ts'

export function create(client: Client.Client): string | undefined {
  return unlocked(client).config.create()
}

export declare namespace create {
  type ErrorType = Conversation.LockedError
}

export function get(client: Client.Client): Conversation.State {
  return Instance.get(client).conversation()
}

export function remove(client: Client.Client, options: remove.Options): void {
  const instance = Instance.get(client)
  if (options.id === instance.conversation().current) unlocked(client)
  instance.config.remove(options.id)
}

export declare namespace remove {
  type Options = {
    id: string
  }

  type ErrorType = Conversation.LockedError
}

export function select(client: Client.Client, options: select.Options): void {
  unlocked(client).config.select(options.id)
}

export declare namespace select {
  type Options = {
    id: string
  }

  type ErrorType = Conversation.LockedError
}

function unlocked(client: Client.Client): Instance.Instance {
  const instance = Instance.get(client)
  if (instance.conversation().status === 'locked') throw new Conversation.LockedError()
  return instance
}
