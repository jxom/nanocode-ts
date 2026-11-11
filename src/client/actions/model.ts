import type * as Contracts from '../../Contracts.ts'
import * as Instance from '../internal/Instance.ts'
import type * as Model from '../Model.ts'

export function get(client: object): Model.State {
  return Instance.get(client).model.get()
}

export function select(client: object, options: select.Options): void {
  Instance.get(client).model.select(options.id)
}

export declare namespace select {
  type Options = {
    id: string
  }

  type ErrorType = Model.NotFoundError | Model.NotReadyError
}

export function setThinking(client: object, options: setThinking.Options): void {
  Instance.get(client).model.setThinking(options.thinking)
}

export declare namespace setThinking {
  type Options = {
    thinking: Contracts.Thinking
  }

  type ErrorType = Model.NotReadyError | Model.ThinkingError
}
