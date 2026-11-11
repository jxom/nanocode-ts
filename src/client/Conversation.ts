import type * as Config from './internal/Config.ts'

export type Conversation = Config.Conversation

export type State =
  | { conversations: readonly Conversation[]; current: string; status: 'locked' }
  | { conversations: readonly Conversation[]; current: string; status: 'ready' }

export class LockedError extends Error {
  override readonly name = 'Conversation.LockedError'

  constructor() {
    super('A turn is running in this conversation. Stop it or wait for it to end first.')
  }
}
