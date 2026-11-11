import type * as Transport from '../client/Transport.ts'

export function custom(transport: Transport.Transport): Transport.Factory {
  return () => transport
}
