'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import {
  type ClipboardEvent,
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  useContext,
  useRef,
} from 'react'
import type * as Client from '../client/Client.ts'
import { AttachmentList } from '../react/Attachments.tsx'
import { useChat, useComposer } from '../react/Hooks.ts'
import * as Skin from './internal/Skin.ts'

type Context = { chat: ReturnType<typeof useChat>; composer: useComposer.ReturnType }

const Context = createContext<Context | undefined>(undefined)

function useComposerContext(): Context {
  const context = useContext(Context)
  if (!context) throw new Root.MissingError()
  return context
}

export function Root(props: Root.Props) {
  const { render, ...rest } = props
  const chat = useChat()
  const composer = useComposer()
  const element = useRender({
    defaultTagName: 'form',
    props: mergeProps(styles.root(), rest, {
      onSubmit: (event: { preventDefault(): void }) => {
        event.preventDefault()
        void composer.submit()
      },
    }),
    render,
    state: {
      empty: composer.value.trim() === '' && composer.attachments.length === 0,
      status: chat.state.status,
    },
  })

  return <Context.Provider value={{ chat, composer }}>{element}</Context.Provider>
}

export declare namespace Root {
  var MissingError: typeof MissingComposerError

  type State = { empty: boolean; status: Client.State['status'] }

  type Props = useRender.ComponentProps<'form', State>
}

class MissingComposerError extends Error {
  override readonly name = 'Composer.MissingError'

  constructor() {
    super('Render this part inside Composer.Root.')
  }
}

Root.MissingError = MissingComposerError

export function Input(props: Input.Props) {
  const { className, ...rest } = props
  const composer = useComposerContext().composer
  const lines = composer.value.split('\n').length

  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void composer.submit()
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (composer.recall(event.key === 'ArrowUp' ? 'previous' : 'next')) event.preventDefault()
  }

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!event.clipboardData.files.length) return
    event.preventDefault()
    composer.attach(event.clipboardData.files)
  }

  return (
    <div {...styles.field({ className })}>
      <span aria-hidden="true" {...Skin.chevron()}>
        ❯
      </span>
      <textarea
        aria-label="Prompt"
        {...rest}
        onChange={(event) => composer.setValue(event.target.value)}
        onKeyDown={key}
        onPaste={paste}
        rows={Math.min(8, Math.max(1, lines))}
        value={composer.value}
        {...Skin.input()}
      />
    </div>
  )
}

export declare namespace Input {
  type Props = Omit<
    ComponentProps<'textarea'>,
    'className' | 'onChange' | 'onKeyDown' | 'onPaste' | 'rows' | 'value'
  > & { className?: string | undefined }
}

export function Submit(props: Submit.Props) {
  const { children, render, ...rest } = props
  const composer = useComposerContext().composer

  return useRender({
    defaultTagName: 'button',
    props: mergeProps(Skin.send(), styles.submit(), rest, {
      children: children ?? <kbd {...Skin.key()}>ENTER</kbd>,
      disabled: !composer.canSubmit,
      type: 'submit',
    }),
    render,
  })
}

export declare namespace Submit {
  type Props = useRender.ComponentProps<'button'>
}

export function Stop(props: Stop.Props) {
  const { children, render, ...rest } = props
  const chat = useComposerContext().chat
  const running = chat.state.status === 'streaming' || chat.state.status === 'submitted'

  return useRender({
    defaultTagName: 'button',
    enabled: running,
    props: mergeProps(Skin.suggestion({ quiet: true }), rest, {
      'aria-label': 'Stop the running turn',
      children: children ?? 'stop',
      onClick: () => void chat.stop(),
      type: 'button',
    }),
    render,
  })
}

export declare namespace Stop {
  type Props = useRender.ComponentProps<'button'>
}

export function Attach(props: Attach.Props) {
  const { children, render, ...rest } = props
  const composer = useComposerContext().composer
  const input = useRef<HTMLInputElement>(null)
  const button = useRender({
    defaultTagName: 'button',
    props: mergeProps(Skin.attach(), rest, {
      'aria-label': 'Attach files',
      children: children ?? '+',
      onClick: () => input.current?.click(),
      type: 'button',
    }),
    render,
  })

  return (
    <>
      <input
        hidden
        multiple
        onChange={(event) => {
          if (event.target.files) composer.attach(event.target.files)
          event.target.value = ''
        }}
        ref={input}
        type="file"
      />
      {button}
    </>
  )
}

export declare namespace Attach {
  type Props = useRender.ComponentProps<'button'>
}

export function Attachments() {
  const composer = useComposerContext().composer

  return (
    <AttachmentList
      items={composer.attachments.map((item) => ({
        ...(item.status === 'ready' ? { attachment: item.attachment } : {}),
        ...(item.status === 'failed' ? { error: item.error.message } : {}),
        id: item.id,
        name: item.name,
        ...(item.preview ? { preview: item.preview } : {}),
        size: item.size,
        status: item.status,
        type: item.type,
      }))}
      onRemove={composer.detach}
    />
  )
}

export function Footer(props: Footer.Props) {
  const { render, ...rest } = props

  return useRender({ defaultTagName: 'div', props: mergeProps(styles.footer(), rest), render })
}

export declare namespace Footer {
  type Props = useRender.ComponentProps<'div'>
}

export const styles = {
  field: style({
    alignItems: 'flex-start',
    display: 'flex',
    gap: 'sm',
    paddingBlock: 'sm',
    paddingInline: 'md',
  }),
  footer: style({
    alignItems: 'center',
    borderTop: '1px solid',
    borderTopColor: 'rule',
    columnGap: 'indent',
    display: 'flex',
    flexWrap: 'wrap',
    paddingBlock: 'xs',
    paddingInline: 'md',
    rowGap: 'xs',
  }),
  root: style({
    borderTop: '1px solid',
    borderTopColor: 'rule',
    display: 'flex',
    flexDirection: 'column',
  }),
  submit: style({ marginLeft: 'auto !custom' }),
}
