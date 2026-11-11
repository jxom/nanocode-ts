import type * as Conversation from '../Conversation.ts'
import * as Instance from '../internal/Instance.ts'

export function create(client: object): string | undefined {
  return Instance.get(client).config.create()
}

export function get(client: object): Conversation.State {
  return Instance.get(client).conversation()
}

export function remove(client: object, options: remove.Options): void {
  Instance.get(client).config.remove(options.id)
}

export declare namespace remove {
  type Options = {
    id: string
  }
}

export function select(client: object, options: select.Options): void {
  Instance.get(client).config.select(options.id)
}

export declare namespace select {
  type Options = {
    id: string
  }
}
