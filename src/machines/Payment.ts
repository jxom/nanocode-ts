import type { Session } from 'mppx/tempo'
import type { Address, Hex } from 'viem'
import * as Mcp from './Mcp.ts'

export type Allowance = {
  budget: string
  calls: number
  windowMs: number
}

export type Inference = 'apiKey' | 'tempo'

export type Tools = 'tempo' | 'off'

export type Deposit = {
  maximum: string
  opening: string
  topUp: string
}

export type Channel = {
  channelId: `0x${string}`
  cumulativeAmount: string
  deposit: string
  descriptor: Session.Precompile.Types.ChannelDescriptor
  opened: boolean
}

export type Closing =
  | { channelId: string; refund: string; state: 'closed' }
  | { channelId: string; reason: string; state: 'failed' }

export type Config = {
  deposit?: Deposit | undefined
  inference?: Inference
  servers?: readonly Mcp.Server[] | false
  tools?: Tools
}

export type Policy = {
  deposit: Deposit | undefined
  inference: Inference
  servers: readonly Mcp.Server[]
  tools: Tools
}

export type Sponsor = {
  account?: Address | undefined
  allowance: Allowance
  deposit?: Deposit | undefined
  key: Hex
}

export const required = 'tempo_wallet_required'

export const unlocked: Record<string, string> = {
  gateway: 'gateway storage, AI and compute',
  mercator: "Mercator's paid APIs",
}

export function resolve(config: Config = {}): Policy {
  const inference = config.inference ?? 'tempo'
  const tools = config.tools ?? 'tempo'
  const servers =
    tools === 'tempo' && config.servers !== false ? (config.servers ?? Mcp.servers) : []
  return { deposit: config.deposit, inference, servers, tools }
}

export function unlocks(servers: readonly Mcp.Server[], scripts = true) {
  return [
    ...servers.map((server) => unlocked[server.name] ?? server.name),
    ...(scripts ? ['every MPP service a script fetches'] : []),
  ].join(', ')
}

export function explanation(servers: readonly Mcp.Server[], scripts = true) {
  return `${required}: this tool is paid with Tempo machine payments, and the user has not connected a Tempo Wallet, so nothing was paid or done. Tell the user to connect their Tempo Wallet with the Connect button in the chat, which unlocks ${unlocks(servers, scripts)}; then retry the call. Do not retry it before they connect.`
}

export function exceeded(servers: readonly Mcp.Server[], options: exceeded.Options) {
  const { allowance, scripts = true } = options
  return `${required}: this deployment pays for each visitor's paid tool calls up to ${allowance.budget} USD and ${allowance.calls} calls every ${allowance.windowMs / 60_000} minutes, and it did not pay for this one, so nothing was paid or done. Tell the user to connect their Tempo Wallet with the Connect button in the chat, which unlocks ${unlocks(servers, scripts)}; then retry the call. Do not retry it before they connect.`
}

export declare namespace exceeded {
  type Options = {
    allowance: Allowance
    scripts?: boolean | undefined
  }
}

export function needsWallet(text: string | undefined) {
  return Boolean(text?.includes(required))
}

export function locked(servers: readonly Mcp.Server[], options: locked.Options = {}): typeof fetch {
  const { fetch: send = globalThis.fetch.bind(globalThis), scripts = true } = options
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const mcp = Mcp.server(url, servers)
    const response = await send(input, mcp ? Mcp.crossOrigin(init) : init)
    if (response.status === 402)
      return Response.json(
        { error: required, message: explanation(servers, scripts) },
        { status: 402 },
      )
    if (!mcp) return response
    const call = await Mcp.call(input, init)
    const result = call ? await Mcp.outcome(response) : undefined
    if (!result?.required) return response
    const paid = await options.sponsor?.pay(result.challenges)
    if (paid) return paid
    const served = await options.fallback?.(input, init)
    if (served) return served
    const id = await response
      .clone()
      .text()
      .then(
        (text) => (JSON.parse(text.match(/^data: ?(.*)$/m)?.[1] ?? text) as { id?: unknown }).id,
        () => null,
      )
    return Response.json({
      id,
      jsonrpc: '2.0',
      result: {
        content: [
          {
            text: options.sponsor
              ? exceeded(servers, { allowance: options.sponsor.allowance, scripts })
              : explanation(servers, scripts),
            type: 'text',
          },
        ],
        isError: true,
      },
    })
  }
}

export declare namespace locked {
  type Options = {
    fallback?:
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>)
      | undefined
    fetch?: typeof fetch | undefined
    scripts?: boolean | undefined
    sponsor?: Sponsoring | undefined
  }

  type Sponsoring = {
    allowance: Allowance
    pay(challenges: readonly Mcp.Challenge[]): Promise<Response | undefined>
  }
}

export function price(challenges: readonly Mcp.Challenge[]): bigint | undefined {
  if (!challenges.length) return undefined
  let highest = 0n
  for (const challenge of challenges) {
    const amount = challenge.request?.amount
    const metered = challenge.intent === 'session' && challenge.request?.unitType === 'request'
    if (!amount || !/^\d+$/.test(amount) || (challenge.intent !== 'charge' && !metered))
      return undefined
    if (BigInt(amount) > highest) highest = BigInt(amount)
  }
  return highest
}

const receiptEvent = /^event: ?payment-receipt\r?$/m
const dataLine = /^data: ?(.*?)\r?$/m
const separator = /\r?\n\r?\n/g
const finalEvent =
  /^(event: ?(response\.(completed|failed|incomplete)|message_stop)|data: ?\[DONE\])\r?$/m
const drainMs = 10_000

export function receipts(
  body: ReadableStream<Uint8Array>,
  onReceipt: (data: string) => unknown,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const reader = body.getReader()
  let buffer = ''
  let final = false
  let pending: Promise<unknown> = Promise.resolve()
  const take = (event: string) => {
    if (finalEvent.test(event)) final = true
    if (!receiptEvent.test(event)) return false
    const data = dataLine.exec(event)?.[1]
    if (data) pending = pending.then(() => onReceipt(data)).catch(() => undefined)
    return true
  }
  const scan = (chunk: Uint8Array | undefined) => {
    buffer += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
    let out = ''
    let start = 0
    for (const match of buffer.matchAll(separator)) {
      const end = match.index + match[0].length
      if (!take(buffer.slice(start, match.index))) out += buffer.slice(start, end)
      start = end
    }
    buffer = buffer.slice(start)
    if (!chunk && buffer && !take(buffer)) out += buffer
    if (!chunk) buffer = ''
    return out
  }
  const drain = async () => {
    const timer = setTimeout(() => void reader.cancel().catch(() => undefined), drainMs)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        scan(value)
      }
      scan(undefined)
    } catch {
    } finally {
      clearTimeout(timer)
    }
    await pending
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          const rest = scan(undefined)
          if (rest) controller.enqueue(encoder.encode(rest))
          await pending
          controller.close()
          return
        }
        const out = scan(value)
        if (out) {
          controller.enqueue(encoder.encode(out))
          return
        }
      }
    },
    cancel(reason) {
      if (final) return drain()
      return reader.cancel(reason)
    },
  })
}
