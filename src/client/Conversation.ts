import type * as Config from './Config.ts'

export type Conversation = Config.Conversation

export type State =
  | { conversations: readonly Conversation[]; current: string; status: 'locked' }
  | { conversations: readonly Conversation[]; current: string; status: 'ready' }
