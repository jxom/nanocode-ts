'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import { Button } from 'nds/react'
import {
  createContext,
  type UIEvent,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type * as Client from '../client/Client.ts'
import { useChat } from '../react/Hooks.ts'

type Context = { pinned: boolean; scroll(): void }

const Context = createContext<Context | undefined>(undefined)

function useConversation(): Context {
  const context = useContext(Context)
  if (!context) throw new Root.MissingError()
  return context
}

export function Root(props: Root.Props) {
  const { render, ...rest } = props
  const chat = useChat()
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  const scroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    setPinned(true)
  }, [])

  useLayoutEffect(() => {
    if (pinned) scroll()
  }, [chat.messages, pinned, scroll])

  const element = useRender({
    defaultTagName: 'div',
    props: mergeProps(styles.root(), rest, {
      onScroll: (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget
        setPinned(Math.ceil(target.scrollTop + target.clientHeight) >= target.scrollHeight)
      },
      role: 'log',
    }),
    ref,
    render,
    state: { status: chat.state.status },
  })

  return <Context.Provider value={{ pinned, scroll }}>{element}</Context.Provider>
}

export declare namespace Root {
  var MissingError: typeof MissingConversationError

  type State = { status: Client.State['status'] }

  type Props = useRender.ComponentProps<'div', State>
}

class MissingConversationError extends Error {
  override readonly name = 'Conversation.MissingError'

  constructor() {
    super('Render this part inside Conversation.Root.')
  }
}

Root.MissingError = MissingConversationError

export function Content(props: Content.Props) {
  const { render, ...rest } = props

  return useRender({ defaultTagName: 'div', props: mergeProps(styles.content(), rest), render })
}

export declare namespace Content {
  type Props = useRender.ComponentProps<'div'>
}

export function Empty(props: Empty.Props) {
  const { render, ...rest } = props
  const empty = useChat().messages.length === 0

  return useRender({
    defaultTagName: 'div',
    enabled: empty,
    props: mergeProps(styles.empty(), rest),
    render,
  })
}

export declare namespace Empty {
  type Props = useRender.ComponentProps<'div'>
}

export function ScrollButton(props: ScrollButton.Props) {
  const { children, className, ...rest } = props
  const conversation = useConversation()
  if (conversation.pinned) return null

  return (
    <Button {...rest} onClick={conversation.scroll} {...styles.scroll({ className })}>
      {children ?? '↓ Latest'}
    </Button>
  )
}

export declare namespace ScrollButton {
  type Props = Omit<Button.Props, 'onClick'>
}

export const styles = {
  content: style({ display: 'flex', flexDirection: 'column', gap: 'sm', minWidth: '0' }),
  empty: style({ color: 'middle', margin: 'auto !custom', textAlign: 'center' }),
  root: style({
    display: 'flex',
    flex: '1 !custom',
    flexDirection: 'column',
    minHeight: '0',
    overflowY: 'auto',
    padding: 'md',
  }),
  scroll: style({
    alignSelf: 'center',
    backgroundColor: 'bg',
    bottom: '0',
    paddingInline: 'cell',
    position: 'sticky',
  }),
}
