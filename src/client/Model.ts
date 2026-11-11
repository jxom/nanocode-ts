import type * as Contracts from '../Contracts.ts'
import type * as Pickers from './Pickers.ts'

export type Harness = Pickers.Harness

export type Listing = {
  harnesses: readonly Harness[]
  payers?: Partial<Record<'plan' | 'wallet', readonly Harness[]>> | undefined
}

export type ListingState =
  | { error: ListError; status: 'failed' }
  | { listing: Listing; status: 'listed' }
  | { status: 'loading' }

export type Model = Pickers.Model

export type Selection = {
  harness: Contracts.ModelProvider
  model: string
  payer: Contracts.Payer
  thinking: Contracts.Thinking
}

export type State =
  | { error: ListError; status: 'failed' }
  | { status: 'loading' }
  | {
      current: Model
      harness: Contracts.ModelProvider
      harnesses: readonly Harness[]
      status: 'ready'
      thinking: Contracts.Thinking
    }

export class ListError extends Error {
  override readonly name = 'Model.ListError'

  constructor(options: { cause?: unknown; reason: string }) {
    super(`No models are available: ${options.reason}`, { cause: options.cause })
  }
}

export class NotFoundError extends Error {
  override readonly name = 'Model.NotFoundError'

  constructor(options: { id: string }) {
    super(`The deployment serves no model "${options.id}".`)
  }
}

export class NotReadyError extends Error {
  override readonly name = 'Model.NotReadyError'

  constructor() {
    super('The deployment has not listed its models yet.')
  }
}

export class ThinkingError extends Error {
  override readonly name = 'Model.ThinkingError'

  constructor(options: { efforts: readonly string[]; id: string; thinking: string }) {
    super(`${options.id} takes thinking ${options.efforts.join(', ')}, not "${options.thinking}".`)
  }
}
