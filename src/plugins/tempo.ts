import type * as Contracts from '../Contracts.ts'
import type * as Model from '../client/Model.ts'
import * as Payer from '../client/Payer.ts'
import * as Plugin from '../client/Plugin.ts'
import * as Keyring from '../machines/Keyring.ts'
import * as Tempo from '../machines/Tempo.ts'
import * as Wallet from '../machines/Wallet.ts'

const label = 'Tempo Wallet'

export function tempo(options: tempo.Options) {
  const { catalog, harness = 'codex', keyring, ...wallet } = options
  const runtimes = new WeakMap<Plugin.Context<tempo.State>, Runtime>()

  const runtime = (context: Plugin.Context<tempo.State>) => {
    const found = runtimes.get(context)
    if (found) return found
    const created: Runtime = {
      keyring: Keyring.create({ ...keyring, headers: context.headers }),
      wallet: Wallet.create({
        ...wallet,
        onPrompt: (prompt) => update(context, { prompt, status: 'authorizing' }),
        storage: context.storage,
      }),
    }
    runtimes.set(context, created)
    return created
  }

  const update = (context: Plugin.Context<tempo.State>, next: tempo.Connection) =>
    context.emit({ ...next, listing: context.getState()?.listing ?? { status: 'loading' } })

  const connected = (context: Plugin.Context<tempo.State>) => {
    const { key } = runtime(context)
    if (!key) throw new Payer.DisconnectedError({ label })
    return key
  }

  return Plugin.from({
    actions: (context: Plugin.Context<tempo.State>) => ({
      async balances(): Promise<tempo.Balances> {
        const key = connected(context)
        const [held, status] = await Promise.all([
          Wallet.balances(key),
          runtime(context).keyring.status(),
        ])
        const spent = Object.values(status?.spent ?? {}).reduce(
          (sum, value) => sum + BigInt(value),
          0n,
        )
        return { ...held, spent }
      },
      async connect(): Promise<void> {
        const found = runtime(context)
        if (found.key) return
        update(context, { status: 'connecting' })
        try {
          const key = await found.wallet.connect()
          await found.keyring.register(key)
          found.key = key
          update(context, { account: account(key), status: 'connected' })
        } catch (error) {
          update(context, {
            error: error instanceof Error ? error : new Error(String(error)),
            status: 'failed',
          })
          throw error
        }
      },
      async disconnect(): Promise<void> {
        const found = runtime(context)
        const key = found.key
        if (!key) return
        const revoked = await found.wallet.revoke(key).then(
          () => undefined,
          (error: unknown) => error,
        )
        await found.keyring.logout().catch(() => undefined)
        found.wallet.forget()
        found.key = undefined
        update(context, { status: 'disconnected' })
        if (revoked) throw revoked
      },
      fund: (): Promise<unknown> => runtime(context).wallet.fund(connected(context)),
      getState: (): tempo.State => context.getState()!,
    }),
    beforeSend: async (context: Plugin.Context<tempo.State>) => {
      const { key, keyring } = runtime(context)
      if (key) await keyring.register(key)
    },
    id: 'tempo',
    initial: { listing: { status: 'loading' }, status: 'disconnected' } as tempo.State,
    payers: ({ listing, state }): readonly Payer.Payer[] => {
      const base = { id: 'wallet', kind: 'wallet' as const, label }
      if (state?.status !== 'connected') return [{ ...base, status: 'disconnected' }]
      if (listing.status === 'loading') return [{ ...base, status: 'loading' }]
      const listed = listing.status === 'listed' ? listing.listing.payers?.wallet : undefined
      if (listed) return [{ ...base, harnesses: listed, status: 'ready' }]
      const gateway = state.listing
      if (gateway.status === 'listed')
        return [{ ...base, harnesses: gateway.harnesses, status: 'ready' }]
      return [{ ...base, ...gateway }]
    },
    setup: (context: Plugin.Context<tempo.State>) => {
      const found = runtime(context)
      const key = found.wallet.restore()
      found.key = key
      context.emit({
        listing: catalog
          ? { status: 'loading' }
          : {
              error: new Error(
                'tempo() has no catalog, and the deployment lists no Tempo Wallet models',
              ),
              status: 'failed',
            },
        ...(key ? { account: account(key), status: 'connected' } : { status: 'disconnected' }),
      })
      if (!catalog) return
      void Tempo.list(catalog, { harness }).then(
        (harnesses) =>
          context.emit({ ...context.getState()!, listing: { harnesses, status: 'listed' } }),
        (error: unknown) =>
          context.emit({
            ...context.getState()!,
            listing: {
              error: error instanceof Error ? error : new Error(String(error)),
              status: 'failed',
            },
          }),
      )
    },
  })
}

export declare namespace tempo {
  type Account = Pick<Wallet.AccessKey, 'address' | 'expiry' | 'keyAddress'>

  type Balances = {
    balance: bigint
    fees: bigint
    remaining: bigint
    spent: bigint
  }

  type Connection =
    | { account: Account; status: 'connected' }
    | { error: Error; status: 'failed' }
    | { prompt: Wallet.Prompt; status: 'authorizing' }
    | { status: 'connecting' }
    | { status: 'disconnected' }

  type Listing =
    | { error: Error; status: 'failed' }
    | { harnesses: readonly Model.Harness[]; status: 'listed' }
    | { status: 'loading' }

  type Options = Omit<Wallet.create.Options, 'onPrompt' | 'storage'> & {
    catalog?: Contracts.ModelCatalog | undefined
    harness?: Contracts.ModelProvider | undefined
    keyring: Omit<Keyring.create.Options, 'headers'>
  }

  type State = Connection & { listing: Listing }
}

type Runtime = {
  key?: Wallet.AccessKey | undefined
  keyring: Keyring.Keyring
  wallet: Wallet.Wallet
}

function account(key: Wallet.AccessKey): tempo.Account {
  return { address: key.address, expiry: key.expiry, keyAddress: key.keyAddress }
}
