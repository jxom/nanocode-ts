import type * as Files from '../internal/Files.ts'
import type * as Tool from './Tool.ts'
import * as Transcript from './Transcript.ts'

export type Message = {
  attachments?: readonly Files.Attachment[] | undefined
  id: string
  parts: readonly Part[]
  role: 'assistant' | 'user'
  steer?: boolean | undefined
}

export type Part =
  | { type: 'error'; text: string }
  | { type: 'reasoning'; state: 'done'; durationMs: number | undefined; text: string }
  | { type: 'reasoning'; state: 'streaming'; startedAt: number | undefined; text: string }
  | { type: 'text'; state: 'done' | 'streaming'; text: string }
  | { type: 'tool'; tool: Tool.Cell }

export function fromEntries(
  entries: readonly Transcript.Entry[],
  options: fromEntries.Options = {},
): Message[] {
  const messages: Message[] = []

  for (const turn of Transcript.turns(entries, options)) {
    const prompt = turn.prompt
    if (prompt)
      messages.push({
        ...(prompt.attachments?.length ? { attachments: prompt.attachments } : {}),
        id: `${turn.id}:user`,
        parts: [{ state: 'done', text: prompt.text, type: 'text' }],
        role: 'user',
        ...(prompt.steer ? { steer: true } : {}),
      })

    if (turn.blocks.length)
      messages.push({ id: `${turn.id}:assistant`, parts: turn.blocks.map(part), role: 'assistant' })
  }

  return messages
}

export declare namespace fromEntries {
  type Options = {
    live?: readonly Transcript.Entry[] | undefined
    pending?: boolean | undefined
  }
}

function part(block: Transcript.TurnBlock): Part {
  if (block.kind === 'tool' && block.tool) return { tool: block.tool, type: 'tool' }
  if (block.kind === 'error') return { text: block.text, type: 'error' }
  if (block.kind === 'reasoning')
    return block.live
      ? { startedAt: block.started_at, state: 'streaming', text: block.text, type: 'reasoning' }
      : {
          durationMs:
            block.started_at !== undefined && block.ended_at !== undefined
              ? block.ended_at - block.started_at
              : undefined,
          state: 'done',
          text: block.text,
          type: 'reasoning',
        }
  return { state: block.live ? 'streaming' : 'done', text: block.text, type: 'text' }
}
