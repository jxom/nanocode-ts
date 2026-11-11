'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import { Menu } from 'nds/react'
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react'
import type * as Client from '../client/Client.ts'
import * as Plans from '../client/Plans.ts'
import type * as Plugin from '../client/Plugin.ts'
import * as Wallet from '../machines/Wallet.ts'
import type { hand } from '../plugins/hand.ts'
import type { plan } from '../plugins/plan.ts'
import type { tempo } from '../plugins/tempo.ts'
import { useClient } from '../react/Hooks.ts'
import * as Skin from './internal/Skin.ts'

type Actions = Plugin.Namespaces<
  readonly [ReturnType<typeof hand>, ReturnType<typeof plan>, ReturnType<typeof tempo>]
>

type Connection =
  | { actions: Actions['hand']; id: 'hand'; state: hand.State }
  | { actions: Actions['plan']; id: 'claude'; state: plan.Claude }
  | { actions: Actions['plan']; id: 'codex'; state: plan.Codex }
  | { actions: Actions['tempo']; id: 'tempo'; state: tempo.State }

type Id = Connection['id']

type Status = Connection['state']['status']

type Phase = 'connected' | 'failed' | 'idle' | 'loading' | 'pending'

type Action = () => Promise<void> | void

type Selection =
  | { error: Error; id: Id; status: 'failed' }
  | { id: Id; status: 'idle' }
  | { id: Id; status: 'running' }

type Context = {
  close(): void
  connections: readonly Connection[]
  run(id: Id, action: Action | undefined): void
  selection: Selection | undefined
}

const labels: Record<Id, string> = {
  claude: `${Plans.name('claude')} plan`,
  codex: `${Plans.name('codex')} plan`,
  hand: 'Your machine',
  tempo: 'Tempo Wallet',
}

const phases: Record<Status, Phase> = {
  authorizing: 'pending',
  connected: 'connected',
  connecting: 'pending',
  disconnected: 'idle',
  failed: 'failed',
  loading: 'loading',
  pairing: 'pending',
  signedIn: 'connected',
  signedOut: 'idle',
  signingIn: 'pending',
}

const marks: Record<Phase, string> = {
  connected: '●',
  failed: '✗',
  idle: '○',
  loading: '…',
  pending: '◌',
}

const reasons: Record<
  Extract<plan.Claude | plan.Codex, { status: 'signedOut' }>['reason'],
  string
> = {
  account_on_hold: 'the account is on hold',
  exchange_uncertain: 'the last sign-in did not finish · sign in again',
  expired: 'the sign-in expired · sign in again',
  pending: 'a sign-in is still open · sign in again',
  signed_out: 'run the model on your subscription',
  validating: 'the deployment checks the sign-in…',
}

const Context = createContext<Context | undefined>(undefined)

function useConnect(): Context {
  const context = useContext(Context)
  if (!context) throw new Root.MissingError()
  return context
}

function installed<const id extends keyof Actions>(
  client: Client.Client,
  id: id,
): client is Client.Client & Pick<Actions, id> {
  return id in client
}

function usePlugin<state>(client: Client.Client, options: usePlugin.Options<state>): state {
  const id = options.id
  const subscribe = useCallback(
    (change: () => void) => {
      client.on(id as never, change)
      return () => void client.off(id as never, change)
    },
    [client, id],
  )
  return useSyncExternalStore(subscribe, options.read, options.read)
}

declare namespace usePlugin {
  type Options<state> = {
    id: keyof Actions
    read(): state
  }
}

export function Root(props: Root.Props) {
  const { render, ...rest } = props
  const client = useClient()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<Selection | undefined>(undefined)
  const hands = usePlugin(client, {
    id: 'hand',
    read: () => (installed(client, 'hand') ? client.hand.getState() : undefined),
  })
  const plans = usePlugin(client, {
    id: 'plan',
    read: () => (installed(client, 'plan') ? client.plan.getState() : undefined),
  })
  const wallet = usePlugin(client, {
    id: 'tempo',
    read: () => (installed(client, 'tempo') ? client.tempo.getState() : undefined),
  })

  const connections = ((): readonly Connection[] => {
    const found: Connection[] = []
    if (installed(client, 'plan') && plans?.codex)
      found.push({ actions: client.plan, id: 'codex', state: plans.codex })
    if (installed(client, 'plan') && plans?.claude)
      found.push({ actions: client.plan, id: 'claude', state: plans.claude })
    if (installed(client, 'tempo') && wallet)
      found.push({ actions: client.tempo, id: 'tempo', state: wallet })
    if (installed(client, 'hand') && hands)
      found.push({ actions: client.hand, id: 'hand', state: hands })
    return found
  })()

  const run = (id: Id, action: Action | undefined) => {
    if (!action) return setSelection({ id, status: 'idle' })
    setSelection({ id, status: 'running' })
    void (async () => action())().then(
      () =>
        setSelection((current) =>
          current?.id === id && current.status === 'running' ? { id, status: 'idle' } : current,
        ),
      (error: unknown) =>
        setSelection((current) =>
          current?.id === id
            ? {
                error: error instanceof Error ? error : new Error(String(error)),
                id,
                status: 'failed',
              }
            : current,
        ),
    )
  }

  const element = useRender({
    defaultTagName: 'div',
    enabled: connections.length > 0,
    props: mergeProps(styles.root(), rest),
    render,
    state: { open },
  })

  return (
    <Context.Provider value={{ close: () => setSelection(undefined), connections, run, selection }}>
      <Menu.Root onOpenChange={setOpen} open={open}>
        {element}
      </Menu.Root>
    </Context.Provider>
  )
}

export declare namespace Root {
  var MissingError: typeof MissingConnectError

  type State = { open: boolean }

  type Props = useRender.ComponentProps<'div', State>
}

class MissingConnectError extends Error {
  override readonly name = 'Connect.MissingError'

  constructor() {
    super('Render this part inside Connect.Root.')
  }
}

Root.MissingError = MissingConnectError

export function Trigger(props: Trigger.Props) {
  const { children, ...rest } = props
  const connections = useConnect().connections
  const connected = connections.filter((entry) => phases[entry.state.status] === 'connected').length
  const label = (() => {
    if (connections.some((entry) => phases[entry.state.status] === 'pending')) return 'connecting…'
    if (connected) return `connected (${connected})`
    return 'connect'
  })()

  return (
    <Menu.Trigger title={connections.map((entry) => labels[entry.id]).join(', ')} {...rest}>
      {children ?? label}
    </Menu.Trigger>
  )
}

export declare namespace Trigger {
  type Props = Menu.Trigger.Props
}

export function Popup(props: Popup.Props) {
  const { children, ...rest } = props
  const connections = useConnect().connections

  return (
    <Menu.Popup aria-label="Connect" {...rest}>
      {children ?? connections.map((entry) => <Item connection={entry.id} key={entry.id} />)}
    </Menu.Popup>
  )
}

export declare namespace Popup {
  type Props = Menu.Popup.Props
}

export function Item(props: Item.Props) {
  const { children, className, connection: id, ...rest } = props
  const connect = useConnect()
  const connection = connect.connections.find((entry) => entry.id === id)
  if (!connection) return null
  const status = connection.state.status

  return (
    <Menu.Item
      {...rest}
      data-status={status}
      disabled={status === 'loading'}
      onClick={() => connect.run(id, action(connection))}
      {...styles.item({ className })}
    >
      {children ?? (
        <>
          <span aria-hidden="true" {...styles.mark()}>
            {marks[phases[status]]}
          </span>
          <span>{labels[id]}</span>
          <span {...styles.detail()}>{detail(connection)}</span>
        </>
      )}
    </Menu.Item>
  )
}

export declare namespace Item {
  type Props = Omit<Menu.Item.Props, 'disabled' | 'onClick'> & { connection: Id }
}

export function Panel(props: Panel.Props) {
  const connect = useConnect()
  const selection = connect.selection
  const connection = connect.connections.find((entry) => entry.id === selection?.id)
  if (!selection || !connection) return null
  if (selection.status !== 'failed' && !flowing(connection)) return null

  return <Frame {...props} connection={connection} selection={selection} />
}

export declare namespace Panel {
  type State = { status: Status }

  type Props = useRender.ComponentProps<'div', State>
}

function Frame(props: Frame.Props) {
  const { children, connection, render, selection, ...rest } = props
  const connect = useConnect()
  const error = selection.status === 'failed' ? selection.error : undefined
  const label = labels[connection.id]

  const body = ((): ReactNode => {
    if (connection.id === 'codex' && connection.state.status === 'signingIn')
      return (
        <Flow
          code={connection.state.code}
          link={{ href: connection.state.url, label: 'open ChatGPT ↗' }}
          status={error?.message ?? 'waiting for your approval…'}
          title="Use your ChatGPT plan"
        >
          Open ChatGPT's device page, sign in and enter this code. The plan's credential stays
          sealed on this deployment's server, and signing out removes it.
        </Flow>
      )
    if (connection.id === 'claude' && connection.state.status === 'signingIn')
      return (
        <ClaudeForm
          actions={connection.actions}
          error={error}
          running={selection.status === 'running'}
          url={connection.state.url}
        />
      )
    if (connection.id === 'hand' && connection.state.status === 'pairing')
      return (
        <Flow
          code={connection.state.command}
          status={error?.message ?? 'waiting for your machine…'}
          title="Run this session on your machine"
        >
          Paste this in a terminal, in the folder the agent works in. It installs nanocode (
          <code>nc</code>) and connects the computer to this session: from the next message the
          agent's code runs there, with its files and its shell.
          {connection.state.short && (
            <>
              {' '}
              With <code>nc</code> installed: <code>{connection.state.short}</code>{' '}
              <Copy key={connection.state.short} text={connection.state.short} />
            </>
          )}
          {connection.state.tab && (
            <>
              {' '}
              <a href={connection.state.tab} rel="noreferrer" target="_blank">
                Make a browser tab this session's machine ↗
              </a>
            </>
          )}
        </Flow>
      )
    if (connection.id === 'tempo' && connection.state.status === 'connecting')
      return (
        <Flow status={error?.message ?? 'waiting for Tempo Wallet…'} title="Connect Tempo Wallet">
          Approve the key in the Tempo Wallet window with a passkey.
        </Flow>
      )
    if (connection.id === 'tempo' && connection.state.status === 'authorizing') {
      const prompt = connection.state.prompt
      return (
        <Flow
          code={prompt.userCode}
          link={{
            href: prompt.verificationUriFull ?? prompt.verificationUri,
            label: 'open Tempo Wallet ↗',
          }}
          status={error?.message ?? 'waiting for your approval…'}
          title="Connect Tempo Wallet"
        >
          Open Tempo Wallet, sign in with a passkey and approve the key with this code.
        </Flow>
      )
    }
    const failure = connection.state.status === 'failed' ? connection.state.error : error
    const retry = action(connection)
    return (
      <Flow
        actions={
          retry && (
            <button
              onClick={() => connect.run(connection.id, retry)}
              type="button"
              {...Skin.handButton()}
            >
              try again
            </button>
          )
        }
        status={failure?.message}
        title={label}
      />
    )
  })()

  return useRender({
    defaultTagName: 'div',
    props: mergeProps(styles.panel(), rest, {
      'aria-label': label,
      children: children ?? body,
      role: 'region',
    }),
    render,
    state: { status: connection.state.status },
  })
}

declare namespace Frame {
  type Props = Panel.Props & { connection: Connection; selection: Selection }
}

function Flow(props: Flow.Props) {
  const close = useConnect().close

  return (
    <>
      <p {...Skin.handTitle()}>{props.title}</p>
      {props.children && <p {...Skin.handText()}>{props.children}</p>}
      {props.code && <pre {...Skin.handCommand()}>{props.code}</pre>}
      <p {...Skin.handActions()}>
        {props.link && (
          <a href={props.link.href} rel="noreferrer" target="_blank" {...Skin.handButton()}>
            {props.link.label}
          </a>
        )}
        {props.code && <Copy key={props.code} text={props.code} />}
        {props.actions}
        <button onClick={close} type="button" {...Skin.handButton()}>
          close
        </button>
        <span aria-live="polite" {...Skin.handStatus()}>
          {props.status}
        </span>
      </p>
    </>
  )
}

declare namespace Flow {
  type Props = {
    actions?: ReactNode
    children?: ReactNode
    code?: string | undefined
    link?: { href: string; label: string } | undefined
    status?: string | undefined
    title: string
  }
}

function ClaudeForm(props: ClaudeForm.Props) {
  const connect = useConnect()
  const [code, setCode] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (code.trim()) connect.run('claude', () => props.actions.complete({ code }))
  }

  return (
    <form aria-label="Use your Claude plan" onSubmit={submit} {...styles.form()}>
      <p {...Skin.handTitle()}>Use your Claude plan</p>
      <p {...Skin.handText()}>
        Open Claude, approve the sign-in and paste the code it shows here. The plan's credential
        stays sealed on this deployment's server, and signing out removes it.
      </p>
      <p {...Skin.handActions()}>
        <a href={props.url} rel="noreferrer" target="_blank" {...Skin.handButton()}>
          open Claude ↗
        </a>
        <input
          aria-label="Code from Claude"
          autoComplete="off"
          onChange={(event) => setCode(event.target.value)}
          placeholder="paste the code"
          value={code}
          {...Skin.planInput()}
        />
        <button disabled={props.running || !code.trim()} type="submit" {...Skin.handButton()}>
          connect
        </button>
        <button onClick={connect.close} type="button" {...Skin.handButton()}>
          close
        </button>
        <span aria-live="polite" {...Skin.handStatus()}>
          {props.error?.message ?? (props.running ? 'checking the code…' : '')}
        </span>
      </p>
    </form>
  )
}

declare namespace ClaudeForm {
  type Props = {
    actions: Actions['plan']
    error: Error | undefined
    running: boolean
    url: string
  }
}

function Copy(props: Copy.Props) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      onClick={() =>
        void navigator.clipboard?.writeText(props.text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
      type="button"
      {...Skin.handButton()}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

declare namespace Copy {
  type Props = { text: string }
}

function action(connection: Connection): Action | undefined {
  const status = connection.state.status
  if (connection.id === 'claude' || connection.id === 'codex') {
    const actions = connection.actions
    const provider = connection.id
    if (status === 'signedIn') return () => actions.signOut({ provider })
    if (status === 'failed' || status === 'signedOut') return () => actions.signIn({ provider })
    return undefined
  }
  if (status === 'connected') return connection.actions.disconnect
  if (status === 'disconnected' || status === 'failed') return connection.actions.connect
  return undefined
}

function flowing(connection: Connection): boolean {
  const status = connection.state.status
  if (status === 'failed') return true
  if (connection.id === 'hand') return status === 'pairing'
  if (connection.id === 'tempo') return status === 'authorizing' || status === 'connecting'
  return status === 'signingIn'
}

function detail(connection: Connection): string {
  if (connection.id === 'hand') {
    const state = connection.state
    if (state.status === 'connected') return `${state.where} · disconnect`
    if (state.status === 'failed') return `${state.error.message} · try again`
    if (state.status === 'pairing') return 'waiting for your machine…'
    return "run the agent's code with your files and shell"
  }

  if (connection.id === 'tempo') {
    const state = connection.state
    const listing = (() => {
      if (state.listing.status === 'failed') return `no models: ${state.listing.error.message}`
      if (state.listing.status === 'loading') return 'listing models…'
      const count = state.listing.harnesses.reduce((sum, entry) => sum + entry.models.length, 0)
      return count === 1 ? '1 model' : `${count} models`
    })()
    const status = (() => {
      if (state.status === 'authorizing') return `approve code ${state.prompt.userCode}`
      if (state.status === 'connected') return `${Wallet.short(state.account.address)} · disconnect`
      if (state.status === 'connecting') return 'waiting for Tempo Wallet…'
      if (state.status === 'failed') return `${state.error.message} · try again`
      return 'pay for models and tools per request'
    })()
    return `${status} · ${listing}`
  }

  if (connection.id === 'codex' && connection.state.status === 'signingIn')
    return `enter ${connection.state.code} at ChatGPT`
  const state = connection.state
  if (state.status === 'failed') return `${state.error.message} · try again`
  if (state.status === 'loading') return 'checking the sign-in…'
  if (state.status === 'signedIn') return 'connected · sign out'
  if (state.status === 'signedOut') return reasons[state.reason]
  return 'paste the code from Claude'
}

export const styles = {
  detail: style({
    color: 'middle',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    selectors: { '[data-highlighted] &': { color: 'inherit !custom' } },
  }),
  form: style({ display: 'contents' }),
  item: style({ columnGap: 'cell', display: 'flex', minWidth: '0', whiteSpace: 'nowrap' }),
  mark: style({
    color: 'accent',
    selectors: { '[data-highlighted] &': { color: 'inherit !custom' } },
  }),
  panel: style({
    borderTop: '1px solid',
    borderTopColor: 'rule',
    display: 'flex',
    flexDirection: 'column',
    gap: 'xs',
    paddingBlock: 'sm',
    paddingInline: 'md',
  }),
  root: style({ display: 'contents' }),
}
