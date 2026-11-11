import type * as Client from '../Client.ts'
import type * as Conversation from '../Conversation.ts'
import * as Instance from '../internal/Instance.ts'
import type * as Payer from '../Payer.ts'

export function get(client: Client.Client): Payer.State {
  return Instance.get(client).payer.get()
}

export function select(client: Client.Client, options: select.Options): void {
  Instance.get(client).payer.select(options.id)
}

export declare namespace select {
  type Options = {
    id: string
  }

  type ErrorType = Conversation.LockedError | Payer.DisconnectedError | Payer.NotFoundError
}
