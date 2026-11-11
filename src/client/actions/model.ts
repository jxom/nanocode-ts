import type * as Contracts from '../../Contracts.ts'
import type * as Client from '../Client.ts'
import type * as Conversation from '../Conversation.ts'
import * as Instance from '../internal/Instance.ts'
import type * as Model from '../Model.ts'

export function get(client: Client.Client): Model.State {
  return Instance.get(client).model.get()
}

export function select(client: Client.Client, options: select.Options): void {
  Instance.get(client).model.select(options.id)
}

export declare namespace select {
  type Options = {
    id: string
  }

  type ErrorType = Conversation.LockedError | Model.NotFoundError | Model.NotReadyError
}

export function setThinking(client: Client.Client, options: setThinking.Options): void {
  Instance.get(client).model.setThinking(options.thinking)
}

export declare namespace setThinking {
  type Options = {
    thinking: Contracts.Thinking
  }

  type ErrorType = Model.NotReadyError | Model.ThinkingError
}
