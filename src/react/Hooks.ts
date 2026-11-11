'use client'

import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as file from '../client/actions/file.ts'
import type * as message from '../client/actions/message.ts'
import type * as Client from '../client/Client.ts'
import * as Instance from '../client/internal/Instance.ts'
import type * as Message from '../client/Message.ts'
import type * as Pickers from '../client/Pickers.ts'
import type * as Plugin from '../client/Plugin.ts'
import type * as Transport from '../client/Transport.ts'
import { ClientContext, NanocodeProvider, preloadMarkdown } from './Provider.tsx'

export interface Register {}

export type ResolvedClient = Register extends { client: infer client extends Client.Client }
  ? client
  : Client.Client

export type ResolvedPlugins =
  ResolvedClient extends Client.Client<infer plugins> ? plugins : readonly Plugin.Plugin[]

export type EventName = Exclude<keyof Client.Events<ResolvedPlugins>, 'event'>

export function useClient(): ResolvedClient {
  const client = useContext(ClientContext)
  if (!client) throw new NanocodeProvider.MissingError()
  return client as ResolvedClient
}

export function useEvent<const name extends EventName>(
  name: name,
): Client.Events<ResolvedPlugins>[name] {
  const client = useClient()
  const subscribe = useCallback(
    (change: () => void) => {
      client.on(name as never, change)
      return () => void client.off(name as never, change)
    },
    [client, name],
  )
  const read = () =>
    Instance.get(client).current(name)?.value as Client.Events<ResolvedPlugins>[name]
  return useSyncExternalStore(subscribe, read, read)
}

export function useChat(): useChat.ReturnType {
  const client = useClient()
  const messages = useEvent('message')
  const state = useEvent('state')
  const sendMessage = useCallback(
    (options: message.send.Options) => {
      void preloadMarkdown().catch(() => {})
      return client.message.send(options)
    },
    [client],
  )
  const stop = useCallback(() => client.message.stop(), [client])
  return { messages, sendMessage, state, stop }
}

export declare namespace useChat {
  type ReturnType = {
    messages: readonly Message.Message[]
    sendMessage(options: message.send.Options): Promise<void>
    state: Client.State
    stop(): Promise<void>
  }
}

export function useComposer(): useComposer.ReturnType {
  const client = useClient()
  const messages = useEvent('message')
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<readonly useComposer.Attachment[]>([])
  const [recalled, setRecalled] = useState<number | undefined>(undefined)
  const uploads = useRef(new Map<string, AbortController>())
  const held = useRef(0)
  held.current = attachments.filter((item) => item.status !== 'failed').length

  const history = useMemo(
    () =>
      messages.flatMap((entry) =>
        entry.role === 'user'
          ? [entry.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')]
          : [],
      ),
    [messages],
  )

  const settle = useCallback(
    (id: string, next: useComposer.Attachment) =>
      setAttachments((current) => current.map((item) => (item.id === id ? next : item))),
    [],
  )

  const attach = useCallback(
    (files: Iterable<File> | ArrayLike<File>) => {
      const limits = client.file.get()
      for (const chosen of Array.from(files)) {
        const name = pastedName(chosen)
        const base = {
          id: crypto.randomUUID(),
          name,
          preview:
            chosen.type.startsWith('image/') && chosen.type !== 'image/svg+xml'
              ? URL.createObjectURL(chosen)
              : undefined,
          size: chosen.size,
          type: chosen.type,
        }
        const refused =
          limits.status === 'unavailable'
            ? new file.UnavailableError()
            : limits.maxFiles !== undefined && held.current >= limits.maxFiles
              ? new file.LimitError({ maxFiles: limits.maxFiles })
              : undefined
        if (refused) {
          setAttachments((current) => [...current, { ...base, error: refused, status: 'failed' }])
          continue
        }
        held.current++
        const controller = new AbortController()
        uploads.current.set(base.id, controller)
        setAttachments((current) => [...current, { ...base, status: 'uploading' }])
        client.file.upload({ file: chosen, name, signal: controller.signal }).then(
          (attachment) => {
            uploads.current.delete(base.id)
            settle(base.id, {
              ...base,
              attachment,
              name: attachment.name,
              status: 'ready',
              type: attachment.type,
            })
          },
          (error: unknown) => {
            uploads.current.delete(base.id)
            if (controller.signal.aborted) return
            settle(base.id, {
              ...base,
              error: error instanceof Error ? error : new Error(String(error)),
              status: 'failed',
            })
          },
        )
      }
    },
    [client, settle],
  )

  const detach = useCallback((id: string) => {
    uploads.current.get(id)?.abort()
    uploads.current.delete(id)
    setAttachments((current) => {
      const found = current.find((item) => item.id === id)
      if (found?.preview) URL.revokeObjectURL(found.preview)
      return current.filter((item) => item.id !== id)
    })
  }, [])

  const text = value.trim()
  const ready = attachments.flatMap((item) => (item.status === 'ready' ? [item.attachment] : []))
  const canSubmit =
    (text.length > 0 || ready.length > 0) &&
    !attachments.some((item) => item.status === 'uploading')

  const submit = async () => {
    if (!canSubmit) return
    setValue('')
    setAttachments([])
    setRecalled(undefined)
    void preloadMarkdown().catch(() => {})
    await client.message.send({ ...(ready.length ? { attachments: ready } : {}), text })
  }

  const recall = (direction: 'next' | 'previous') => {
    if (!history.length || (recalled === undefined && value) || value.includes('\n')) return false
    const next =
      direction === 'previous'
        ? recalled === undefined
          ? history.length - 1
          : Math.max(0, recalled - 1)
        : recalled === undefined
          ? undefined
          : recalled + 1
    const index = next === undefined || next >= history.length ? undefined : next
    setRecalled(index)
    setValue(index === undefined ? '' : history[index]!)
    return true
  }

  return { attach, attachments, canSubmit, detach, recall, setValue, submit, value }
}

export declare namespace useComposer {
  type Attachment = {
    id: string
    name: string
    preview: string | undefined
    size: number
    type: string
  } & (
    | { attachment: Transport.Attachment; status: 'ready' }
    | { error: Error; status: 'failed' }
    | { status: 'uploading' }
  )

  type ReturnType = {
    attach(files: Iterable<File> | ArrayLike<File>): void
    attachments: readonly Attachment[]
    canSubmit: boolean
    detach(id: string): void
    recall(direction: 'next' | 'previous'): boolean
    setValue(value: string): void
    submit(): Promise<void>
    value: string
  }
}

export function usePicker(options: usePicker.Options): usePicker.ReturnType {
  const [query, setQueryState] = useState('')
  const [moved, setMoved] = useState<number | undefined>(undefined)
  const items = options.items(query)
  const choices = items.filter((item) => item.kind === 'choice')
  const last = Math.max(0, choices.length - 1)
  const index = Math.min(
    moved ??
      Math.max(
        0,
        choices.findIndex((item) => item.current),
      ),
    last,
  )
  const highlighted = choices[index]

  const setQuery = (next: string) => {
    setQueryState(next)
    setMoved(undefined)
  }

  return {
    choose: () => {
      if (highlighted) options.onChoose(highlighted)
    },
    highlighted,
    items,
    move: (delta) => setMoved(Math.min(Math.max(0, index + delta), last)),
    query,
    setQuery,
  }
}

export declare namespace usePicker {
  type Options = {
    items(query: string): readonly Pickers.Item[]
    onChoose(item: Pickers.Item): void
  }

  type ReturnType = {
    choose(): void
    highlighted: Pickers.Item | undefined
    items: readonly Pickers.Item[]
    move(delta: number): void
    query: string
    setQuery(query: string): void
  }
}

function pastedName(chosen: File): string {
  if (chosen.name && chosen.name !== 'image.png' && chosen.name !== 'image.jpeg') return chosen.name
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `pasted-${stamp}.${(chosen.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`
}
