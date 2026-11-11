import type * as Transport from '../client/Transport.ts'
import * as CloudflareTransport from '../cloudflare/Transport.ts'
import * as VercelTransport from '../vercel/Transport.ts'

export function cloudflare(options: cloudflare.Options = {}): Transport.Factory {
  return (context) =>
    CloudflareTransport.create({
      ...options,
      headers: () => ({ ...context.headers(), ...options.headers?.() }),
      model: () => {
        const selection = context.selection()
        return {
          model: selection.model,
          payer: selection.payer,
          provider: selection.harness,
          thinking: selection.thinking,
        }
      },
      session: context.session,
    })
}

export declare namespace cloudflare {
  type Options = Omit<CloudflareTransport.create.Options, 'model' | 'session'>
}

export function custom(transport: Transport.Transport): Transport.Factory {
  return () => transport
}

export function vercel(options: vercel.Options = {}): Transport.Factory {
  return (context) =>
    VercelTransport.create({
      ...options,
      headers: () => ({ ...context.headers(), ...options.headers?.() }),
      selection: () => {
        const selection = context.selection()
        return {
          effort: selection.thinking,
          harness: selection.harness,
          model: selection.model,
          payer: selection.payer,
        }
      },
      session: context.session,
    })
}

export declare namespace vercel {
  type Options = Omit<VercelTransport.create.Options, 'selection' | 'session'>
}
