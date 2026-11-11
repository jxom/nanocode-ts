'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type * as Client from '../client/Client.ts'
import type * as Plugin from '../client/Plugin.ts'
import type * as ToolCell from '../client/Tool.ts'
import * as Payment from '../machines/Payment.ts'
import * as Wallet from '../machines/Wallet.ts'
import type { tempo } from '../plugins/tempo.ts'
import { useChat, useClient, useEvent } from '../react/Hooks.ts'
import * as Skin from './internal/Skin.ts'

type Installed = Client.Client & Plugin.Namespaces<readonly [ReturnType<typeof tempo>]>

type Tempo = { actions: Installed['tempo']; state: tempo.State }

type Balances =
  | { balances: tempo.Balances; status: 'loaded' }
  | { balances: tempo.Balances; status: 'refreshing' }
  | { error: Error; status: 'failed' }
  | { status: 'loading' }

const retry = 'Retry the paid tool call that needed a Tempo Wallet; it is connected now.'

function installed(client: Client.Client): client is Installed {
  return 'tempo' in client
}

function useTempo(): Tempo {
  const client = useClient()
  const subscribe = useCallback(
    (change: () => void) => {
      client.on('tempo' as never, change)
      return () => void client.off('tempo' as never, change)
    },
    [client],
  )
  const read = () => (installed(client) ? client.tempo.getState() : undefined)
  const state = useSyncExternalStore(subscribe, read, read)
  if (!state || !installed(client)) throw new NotInstalledError()
  return { actions: client.tempo, state }
}

function useBalances(wallet: Tempo): useBalances.ReturnType {
  const chat = useEvent('state')
  const running = chat.status === 'streaming' || chat.status === 'submitted'
  const key = wallet.state.status === 'connected' ? wallet.state.account.keyAddress : undefined
  const balances = wallet.actions.balances
  const [state, setState] = useState<Balances>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!key) return setState({ status: 'loading' })
    if (running) return
    let stopped = false
    setState((current) =>
      current.status === 'loaded' || current.status === 'refreshing'
        ? { balances: current.balances, status: 'refreshing' }
        : { status: 'loading' },
    )
    balances().then(
      (next) => {
        if (!stopped) setState({ balances: next, status: 'loaded' })
      },
      (error: unknown) => {
        if (!stopped)
          setState({
            error: error instanceof Error ? error : new Error(String(error)),
            status: 'failed',
          })
      },
    )
    return () => {
      stopped = true
    }
  }, [balances, key, running, version])

  return { refresh: () => setVersion((current) => current + 1), state }
}

declare namespace useBalances {
  type ReturnType = { refresh(): void; state: Balances }
}

export function Card(props: Card.Props) {
  const { cell, children, render, ...rest } = props
  const wallet = useTempo()
  const chat = useChat()
  const status = wallet.state.status
  const busy = chat.state.status === 'streaming' || chat.state.status === 'submitted'
  const blocked = chat.messages.flatMap((message, index) =>
    message.parts.flatMap((part) =>
      part.type === 'tool' && paid(part.tool) ? [{ index, tool: part.tool }] : [],
    ),
  )
  const last = blocked.at(-1)
  const latest =
    last?.tool.call_id === cell.call_id &&
    !chat.messages.slice(last.index + 1).some((message) => message.role === 'user')
  const connect = () => void wallet.actions.connect().catch(() => undefined)

  const body = ((): ReactNode => {
    const state = wallet.state
    if (state.status === 'connected')
      return (
        <>
          <p {...Skin.walletCardTitle()}>Tempo Wallet connected</p>
          <p {...Skin.walletCardText()}>
            Paid tools are unlocked for {Wallet.short(state.account.address)}.
          </p>
          <div {...Skin.walletCardActions()}>
            <button
              disabled={busy}
              onClick={() => void chat.sendMessage({ text: retry })}
              type="button"
              {...Skin.walletCardButton()}
            >
              Retry
            </button>
          </div>
        </>
      )
    if (state.status === 'failed')
      return (
        <>
          <p {...Skin.walletCardTitle()}>Tempo Wallet did not connect</p>
          <p aria-live="polite" {...Skin.walletCardText()}>
            {state.error.message}
          </p>
          <div {...Skin.walletCardActions()}>
            <button onClick={connect} type="button" {...Skin.walletCardButton()}>
              Try again
            </button>
          </div>
        </>
      )
    return (
      <>
        <p {...Skin.walletCardTitle()}>This tool is paid with Tempo</p>
        <p aria-live="polite" {...Skin.walletCardText()}>
          {(() => {
            if (state.status === 'authorizing')
              return (
                <>
                  Open{' '}
                  <a
                    href={state.prompt.verificationUriFull ?? state.prompt.verificationUri}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Tempo Wallet ↗
                  </a>{' '}
                  and approve the key with code <b>{state.prompt.userCode}</b>.
                </>
              )
            if (state.status === 'connecting')
              return 'Approve the key in the Tempo Wallet window with a passkey.'
            return 'Connect Tempo Wallet to pay for this tool per request. Tempo Wallet asks to approve a key with a spending limit.'
          })()}
        </p>
        <div {...Skin.walletCardActions()}>
          <button
            disabled={state.status !== 'disconnected'}
            onClick={connect}
            type="button"
            {...Skin.walletCardButton()}
          >
            {state.status === 'disconnected' ? 'Connect Tempo Wallet' : 'Waiting for Tempo Wallet…'}
          </button>
        </div>
      </>
    )
  })()

  return useRender({
    defaultTagName: 'div',
    enabled: paid(cell) && (status !== 'connected' || latest),
    props: mergeProps(Skin.walletCard(), rest, { children: children ?? body }),
    render,
    state: { status },
  })
}

export declare namespace Card {
  type State = { status: tempo.State['status'] }

  type Props = useRender.ComponentProps<'div', State> & { cell: ToolCell.Cell }
}

export function Meter(props: Meter.Props) {
  const { children, render, ...rest } = props
  const wallet = useTempo()
  const balances = useBalances(wallet)
  const [open, setOpen] = useState(false)

  return useRender({
    defaultTagName: 'div',
    props: mergeProps(styles.meter(), rest, {
      'aria-label': 'Tempo Wallet',
      children: children ?? (
        <>
          <button
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            type="button"
            {...styles.meterHead()}
          >
            <span aria-hidden="true" {...Skin.spendAccent()}>
              ⚡
            </span>
            <span>{headline(wallet, balances.state)}</span>
          </button>
          {open && (
            <div {...styles.meterRows()}>
              <Details balances={balances} wallet={wallet} />
            </div>
          )}
        </>
      ),
    }),
    render,
    state: { open, status: wallet.state.status },
  })
}

export declare namespace Meter {
  type State = { open: boolean; status: tempo.State['status'] }

  type Props = useRender.ComponentProps<'div', State>
}

export class NotInstalledError extends Error {
  override readonly name = 'Wallet.NotInstalledError'

  constructor() {
    super('Wallet parts read the tempo plugin. Pass tempo() in the plugins of the client.')
  }
}

export function Spend(props: Spend.Props) {
  const { children, render, ...rest } = props
  const wallet = useTempo()
  const balances = useBalances(wallet)

  return useRender({
    defaultTagName: 'div',
    props: mergeProps(Skin.spend(), rest, {
      'aria-label': 'Tempo Wallet',
      children: children ?? (
        <>
          <p {...Skin.spendTitle()}>
            <span aria-hidden="true" {...Skin.spendAccent()}>
              ⚡
            </span>{' '}
            {headline(wallet, balances.state)}
          </p>
          <Details balances={balances} wallet={wallet} />
        </>
      ),
    }),
    render,
    state: { status: wallet.state.status },
  })
}

export declare namespace Spend {
  type State = { status: tempo.State['status'] }

  type Props = useRender.ComponentProps<'div', State>
}

function Details(props: Details.Props) {
  const wallet = props.wallet
  const state = wallet.state
  const [failure, setFailure] = useState<Error | undefined>(undefined)

  const act = (action: () => Promise<unknown>) => {
    setFailure(undefined)
    void action().catch((error: unknown) =>
      setFailure(error instanceof Error ? error : new Error(String(error))),
    )
  }

  const listing = (() => {
    if (state.listing.status === 'failed')
      return `The Tempo gateway models did not load: ${state.listing.error.message}`
    if (state.listing.status === 'loading') return 'Listing the Tempo gateway models…'
    const count = state.listing.harnesses.reduce((sum, entry) => sum + entry.models.length, 0)
    return `The Tempo gateway lists ${count === 1 ? '1 model' : `${count} models`}.`
  })()

  if (state.status === 'connected') {
    const account = state.account
    const until = new Date(account.expiry * 1000).toLocaleString(undefined, {
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
    })
    const balances = props.balances.state
    return (
      <>
        <p>
          {Wallet.short(account.address)} · key {Wallet.short(account.keyAddress)} until {until}
        </p>
        {balances.status === 'failed' && (
          <p aria-live="polite" {...Skin.spendEmpty()}>
            The balances did not load: {balances.error.message}
          </p>
        )}
        {balances.status === 'loading' && (
          <p aria-live="polite" {...Skin.spendEmpty()}>
            Reading the balances…
          </p>
        )}
        {(balances.status === 'loaded' || balances.status === 'refreshing') && (
          <>
            <p>
              {Wallet.format(balances.balances.balance)} {Wallet.mach.symbol} held ·{' '}
              {Wallet.format(balances.balances.fees)} {Wallet.usdc.symbol} for fees
            </p>
            <p>
              The key may spend {Wallet.format(balances.balances.remaining)} {Wallet.mach.symbol}{' '}
              more ·{' '}
              <span {...Skin.spendCalls()}>
                paid {Wallet.format(balances.balances.spent)} {Wallet.mach.symbol} on this site
              </span>
            </p>
          </>
        )}
        <p {...Skin.spendEmpty()}>{listing}</p>
        <p {...Skin.handActions()}>
          <button
            disabled={balances.status === 'loading' || balances.status === 'refreshing'}
            onClick={props.balances.refresh}
            type="button"
            {...Skin.handButton()}
          >
            {balances.status === 'refreshing' ? 'refreshing…' : 'refresh'}
          </button>
          <button onClick={() => act(wallet.actions.fund)} type="button" {...Skin.handButton()}>
            add {Wallet.mach.symbol}
          </button>
          {failure && (
            <span aria-live="polite" {...Skin.handStatus()}>
              {failure.message}
            </span>
          )}
        </p>
      </>
    )
  }
  if (state.status === 'authorizing')
    return (
      <p aria-live="polite">
        Open{' '}
        <a
          href={state.prompt.verificationUriFull ?? state.prompt.verificationUri}
          rel="noreferrer"
          target="_blank"
        >
          Tempo Wallet ↗
        </a>{' '}
        and approve the key with code <b>{state.prompt.userCode}</b>.
      </p>
    )
  if (state.status === 'connecting')
    return <p aria-live="polite">Approve the key in the Tempo Wallet window with a passkey.</p>
  return (
    <>
      <p aria-live="polite" {...Skin.spendEmpty()}>
        {state.status === 'failed' ? state.error.message : 'Tempo Wallet is not connected.'}
      </p>
      <p {...Skin.spendEmpty()}>{listing}</p>
      <p {...Skin.handActions()}>
        <button
          onClick={() => void wallet.actions.connect().catch(() => undefined)}
          type="button"
          {...Skin.handButton()}
        >
          {state.status === 'failed' ? 'try again' : 'connect Tempo Wallet'}
        </button>
      </p>
    </>
  )
}

declare namespace Details {
  type Props = { balances: useBalances.ReturnType; wallet: Tempo }
}

function headline(wallet: Tempo, balances: Balances): string {
  const state = wallet.state
  if (state.status === 'authorizing') return 'Tempo Wallet · waiting for your approval'
  if (state.status === 'connecting') return 'Tempo Wallet · connecting…'
  if (state.status === 'disconnected') return 'Tempo Wallet · not connected'
  if (state.status === 'failed') return 'Tempo Wallet · not connected'
  if (balances.status === 'failed') return `${Wallet.short(state.account.address)} · no balances`
  if (balances.status === 'loading')
    return `${Wallet.short(state.account.address)} · reading balances…`
  return `${Wallet.format(balances.balances.balance)} ${Wallet.mach.symbol} · paid ${Wallet.format(balances.balances.spent)} ${Wallet.mach.symbol}`
}

function paid(cell: ToolCell.Cell): boolean {
  return Payment.needsWallet(cell.output) || cell.children.some(paid)
}

export const styles = {
  meter: style({
    borderTop: '1px solid',
    borderTopColor: 'rule',
    display: 'flex',
    flexDirection: 'column',
    paddingBlock: 'xs',
    paddingInline: 'md',
  }),
  meterHead: style({
    alignItems: 'center',
    backgroundColor: 'transparent',
    border: 'none',
    color: 'inherit !custom',
    cursor: 'pointer',
    display: 'flex',
    font: 'inherit !custom',
    gap: 'cell',
    padding: '0',
    textAlign: 'left',
  }),
  meterRows: style({
    display: 'flex',
    flexDirection: 'column',
    gap: 'xs',
    paddingLeft: 'indent',
    paddingTop: 'xs',
    selectors: { '& p': { margin: '0' } },
  }),
}
