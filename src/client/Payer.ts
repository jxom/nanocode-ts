import type * as Contracts from '../Contracts.ts'
import type * as Model from './Model.ts'

export type Payer = {
  id: string
  kind: Contracts.Payer
  label: string
} & (
  | { error: Error; status: 'failed' }
  | { harnesses: readonly Model.Harness[]; status: 'ready' }
  | { status: 'disconnected' }
  | { status: 'loading' }
)

export type State = {
  current: Payer
  payers: readonly Payer[]
}

export class DisconnectedError extends Error {
  override readonly name = 'Payer.DisconnectedError'

  constructor(options: { label: string }) {
    super(`${options.label} is not connected.`)
  }
}

export class NotFoundError extends Error {
  override readonly name = 'Payer.NotFoundError'

  constructor(options: { id: string; ids: readonly string[] }) {
    super(`No payer "${options.id}". The payers are ${options.ids.join(', ')}.`)
  }
}
