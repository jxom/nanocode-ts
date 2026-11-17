import type { KeyAuthorization } from 'ox/tempo'
import type { Address, Client, Hex, Transport } from 'viem'
import type * as Chains from 'viem/tempo/chains'
import type * as Tempo from 'viem/tempo'

const modules = () =>
  Promise.all([
    import('accounts'),
    import('accounts/internal'),
    import('ox/tempo'),
    import('viem'),
    import('viem/accounts'),
    import('viem/actions'),
    import('viem/tempo'),
    import('viem/tempo/chains'),
  ])

let loaded: ReturnType<typeof modules> | undefined

function load() {
  return (loaded ??= modules())
}

export function preload() {
  const start = () =>
    void load().catch(() => {
      loaded = undefined
    })
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 })
  else setTimeout(start, 1000)
}

export const mach = {
  address: '0x20c000000000000000000000f37de3740adec032',
  chainId: 4217,
  decimals: 6,
  symbol: 'MACH',
} as const

export const usdc = {
  address: '0x20c000000000000000000000b9537d11c60e8b50',
  symbol: 'USDC.e',
} as const

export const allowance = 2_000_000n

export const feeAllowance = 100_000n

export const lifetime = 86_400

export const rpc = 'https://rpc.tempo.xyz'

export const id = 'https://id.tempo.xyz'

export const clientId = 'cli:nanocode'

const escrow: Address = '0x4d50500000000000000000000000000000000000'

const swapper: Address = '0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F'

const selectors = {
  approve: '0x095ea7b3',
  open: '0xedc53b00',
  requestClose: '0x675402e5',
  swapTo: '0x34189fed',
  topUp: '0xdc48471e',
  transferWithMemo: '0x95777d59',
  withdraw: '0x41e2c664',
} as const

const storageKey = 'nanocode.machines.tempo-id'

const legacyStorageKey = 'nanocode.machines.wallet'

export type Tokens = {
  accessToken: string
  expiresAt: number
  refreshToken?: string | undefined
}

export type AccessKey = {
  address: Address
  authorization: KeyAuthorization.Rpc
  expiry: number
  key: Hex
  keyAddress: Address
  tokens?: Tokens | undefined
}

export type Prompt = {
  userCode: string
  verificationUri: string
  verificationUriFull: string | undefined
}

export type Options = {
  name: string
  relay: string
  websiteUrl: string
}

let options: Options = {
  name: 'nanocode machines',
  relay: 'api/device/',
  websiteUrl: 'https://nanocode.xyz/machines/',
}

export function configure(next: Partial<Options>) {
  options = { ...options, ...next }
}

let prompt: (prompt: Prompt) => void = () => {}

export function framed() {
  return document.documentElement.hasAttribute('data-xframe')
}

let formsBlocked: boolean | undefined

export function sandboxed() {
  if (formsBlocked !== undefined) return formsBlocked
  const form = document.createElement('form')
  let submitted = false
  form.addEventListener('submit', (event) => {
    submitted = true
    event.preventDefault()
  })
  document.body.append(form)
  form.requestSubmit()
  form.remove()
  formsBlocked = !submitted
  return formsBlocked
}

export function onPrompt(listener: (prompt: Prompt) => void) {
  prompt = listener
  return () => {
    prompt = () => {}
  }
}

const steps: Record<string, string> = { '/device/code': 'code', '/oauth2/token': 'token' }

function relay(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const step = url.origin === id ? steps[url.pathname] : undefined
  return fetch(step ? new URL(`${options.relay}${step}`, location.href) : input, init)
}

export function permissions(expiry: number) {
  return {
    expiry,
    limits: [
      { limit: allowance, token: mach.address },
      { limit: feeAllowance, token: usdc.address },
    ],
    scopes: [
      { address: mach.address, selector: selectors.transferWithMemo },
      { address: mach.address, recipients: [swapper], selector: selectors.approve },
      { address: swapper, selector: selectors.swapTo },
      ...[selectors.open, selectors.topUp, selectors.requestClose, selectors.withdraw].map(
        (selector) => ({ address: escrow, selector }),
      ),
    ],
  }
}

export async function reader(): Promise<Client<Transport, typeof Chains.tempo>> {
  const [, , , , , , { createClient, http }, { tempo }] = await load()
  return createClient({ chain: tempo, transport: http(rpc) })
}

export function restore(): AccessKey | undefined {
  localStorage.removeItem(legacyStorageKey)
  const saved = localStorage.getItem(storageKey)
  if (!saved) return undefined
  const parsed = JSON.parse(saved) as AccessKey
  const fees = parsed.authorization.limits?.some(
    (limit) => limit.token.toLowerCase() === usdc.address,
  )
  if (parsed.expiry * 1000 > Date.now() && fees) return parsed
  localStorage.removeItem(storageKey)
  return undefined
}

export async function reusable(connected: AccessKey) {
  const [, , , { isAddressEqual }, , , { Actions }] = await load()
  const client = await reader()
  const metadata = await Actions.accessKey.getMetadata(client, {
    accessKey: connected.keyAddress,
    account: connected.address,
  })
  if (!isAddressEqual(metadata.address, connected.keyAddress)) return true
  if (metadata.isRevoked) return false
  const { remaining } = await Actions.accessKey.getRemainingLimit(client, {
    accessKey: connected.keyAddress,
    account: connected.address,
    token: mach.address,
  })
  return remaining > 0n
}

export async function connect(parameters: connect.Parameters = {}): Promise<AccessKey> {
  const saved = restore()
  if (saved && (await reusable(saved))) return saved
  const [{ Accounts }, { Actions }, , , { generatePrivateKey }, , { Account }, { tempo }] =
    await load()
  const key = generatePrivateKey()
  const access = Account.fromSecp256k1(key)
  const config = Accounts.from({
    chain: tempo.id,
    clientId,
    fetch: relay as typeof fetch,
    url: id,
  })
  const expiry = Math.floor(Date.now() / 1000) + lifetime
  const grant = await Actions.device.authorize(config, {
    accessKey: {
      ...permissions(expiry),
      chainId: tempo.id,
      publicKey: access.publicKey,
      type: 'secp256k1',
    },
    device: options.name,
    funding: { amount: format(allowance), token: mach.address },
  })
  prompt({
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    verificationUriFull: grant.verificationUriComplete,
  })
  if (!framed()) window.open(grant.verificationUriComplete, '_blank', 'noopener')
  const approved = await grant.wait(parameters.signal ? { signal: parameters.signal } : {})
  const authorization = approved.accessKey?.keyAuthorization
  if (!authorization) throw new Error('Tempo ID returned no access key.')
  const connected: AccessKey = {
    address: approved.accessKey.account,
    authorization,
    expiry: authorization.expiry == null ? expiry : Number(BigInt(authorization.expiry)),
    key,
    keyAddress: access.address,
    tokens: {
      accessToken: approved.accessToken,
      expiresAt: approved.expiresAt,
      ...(approved.refreshToken ? { refreshToken: approved.refreshToken } : {}),
    },
  }
  localStorage.setItem(storageKey, JSON.stringify(connected))
  return connected
}

export declare namespace connect {
  type Parameters = {
    signal?: AbortSignal | undefined
  }
}

export const connectionsUrl = `${id}/connections`

async function accessToken(tokens: Tokens): Promise<string | undefined> {
  if (tokens.expiresAt > Date.now()) return tokens.accessToken
  if (!tokens.refreshToken) return undefined
  const response = await fetch(`${id}/oauth2/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
    method: 'POST',
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  return ((await response.json()) as { access_token?: string }).access_token
}

export async function revoke(connected: AccessKey) {
  const token = connected.tokens ? await accessToken(connected.tokens) : undefined
  const reason = await (async () => {
    if (!token) return 'no Tempo ID session'
    const response = await fetch(`${id}/v1/access-keys/revoke`, {
      body: JSON.stringify({
        account: connected.address,
        address: connected.keyAddress,
        chainId: mach.chainId,
        client_id: clientId,
      }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'POST',
    }).catch(() => undefined)
    if (response?.ok) return undefined
    const body = (await response?.json().catch(() => undefined)) as
      | { error?: string; code?: string }
      | undefined
    return body?.error ?? body?.code ?? (response ? `HTTP ${response.status}` : 'no response')
  })()
  if (!reason) return
  window.open(connectionsUrl, '_blank', 'noopener')
  throw new RevokeRequiredError(reason)
}

export class RevokeRequiredError extends Error {
  override name = 'RevokeRequiredError'
  constructor(reason: string) {
    super(`revoke it on Tempo ID's connections page, ${connectionsUrl} (${reason})`)
  }
}

export function forget() {
  localStorage.removeItem(storageKey)
  localStorage.removeItem(legacyStorageKey)
}

export async function fund(connected: AccessKey) {
  window.open(fundingUrl(connected), '_blank', 'noopener')
}

export function fundingUrl(connected: AccessKey) {
  const url = new URL('/deposit', id)
  url.searchParams.set('address', connected.address)
  url.searchParams.set('chain', String(mach.chainId))
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('funding_hint', format(allowance))
  url.searchParams.set('funding_token', mach.address)
  return url.toString()
}

export async function signer(
  connected: AccessKey,
): Promise<ReturnType<typeof Tempo.Account.fromSecp256k1>> {
  const [, , { KeyAuthorization }, , , , { Account, KeyAuthorizationManager }, { tempo }] =
    await load()
  const keyAuthorizationManager = KeyAuthorizationManager.memory()
  await keyAuthorizationManager.set(
    { accessKey: connected.keyAddress, address: connected.address, chainId: tempo.id },
    KeyAuthorization.fromRpc(connected.authorization),
  )
  return Account.fromSecp256k1(connected.key, {
    access: connected.address,
    keyAuthorizationManager,
  })
}

export async function balances(connected: AccessKey) {
  const [, , , , , , { Actions }] = await load()
  const client = await reader()
  const [balance, fees, remaining] = await Promise.all([
    Actions.token.getBalance(client, { account: connected.address, token: mach.address }),
    Actions.token.getBalance(client, { account: connected.address, token: usdc.address }),
    Actions.accessKey
      .getRemainingLimit(client, {
        accessKey: connected.keyAddress,
        account: connected.address,
        token: mach.address,
      })
      .then(
        (limit) => limit.remaining,
        () => allowance,
      ),
  ])
  return { balance: balance.amount, fees: fees.amount, remaining }
}

export function short(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

export function format(atomics: bigint) {
  return `${atomics / 1_000_000n}.${(atomics % 1_000_000n).toString().padStart(6, '0')}`
}
