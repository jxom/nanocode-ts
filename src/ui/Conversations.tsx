'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import { createContext, type ReactNode, useContext } from 'react'
import type * as Conversation from '../client/Conversation.ts'
import { useClient, useEvent } from '../react/Hooks.ts'
import * as Skin from './internal/Skin.ts'

const Context = createContext<Conversation.State | undefined>(undefined)

const ItemContext = createContext<Conversation.Conversation | undefined>(undefined)

function useConversations(): Conversation.State {
  const state = useContext(Context)
  if (!state) throw new Root.MissingError()
  return state
}

function useItem(): Conversation.Conversation {
  const conversation = useContext(ItemContext)
  if (!conversation) throw new Item.MissingError()
  return conversation
}

export function Root(props: Root.Props) {
  const { render, ...rest } = props
  const state = useEvent('conversation')
  const element = useRender({
    defaultTagName: 'nav',
    props: mergeProps(styles.root(), { 'aria-label': 'Conversations' }, rest),
    render,
    state: { status: state.status },
  })

  return <Context.Provider value={state}>{element}</Context.Provider>
}

export declare namespace Root {
  var MissingError: typeof MissingConversationsError

  type State = { status: Conversation.State['status'] }

  type Props = useRender.ComponentProps<'nav', State>
}

class MissingConversationsError extends Error {
  override readonly name = 'Conversations.MissingError'

  constructor() {
    super('Render this part inside Conversations.Root.')
  }
}

Root.MissingError = MissingConversationsError

export function New(props: New.Props) {
  const { children, render, ...rest } = props
  const client = useClient()
  const state = useConversations()
  const empty = useEvent('message').length === 0

  return useRender({
    defaultTagName: 'button',
    props: mergeProps(styles.new(), rest, {
      children: children ?? 'New chat',
      disabled: empty || state.status === 'locked',
      onClick: () => void client.conversation.create(),
      type: 'button',
    }),
    render,
  })
}

export declare namespace New {
  type Props = useRender.ComponentProps<'button'>
}

export function List(props: List.Props) {
  const { children, render, ...rest } = props
  const state = useConversations()

  return useRender({
    defaultTagName: 'ul',
    props: mergeProps(styles.list(), rest, {
      children: state.conversations.map((conversation) =>
        children ? (
          children(conversation)
        ) : (
          <Item conversation={conversation} key={conversation.id} />
        ),
      ),
    }),
    render,
  })
}

export declare namespace List {
  type Props = Omit<useRender.ComponentProps<'ul'>, 'children'> & {
    children?: ((conversation: Conversation.Conversation) => ReactNode) | undefined
  }
}

export function Item(props: Item.Props) {
  const { children, conversation, render, ...rest } = props
  const state = useConversations()
  const element = useRender({
    defaultTagName: 'li',
    props: mergeProps(styles.item(), rest, {
      children: children ?? (
        <>
          <Select />
          <Remove />
        </>
      ),
    }),
    render,
    state: { current: conversation.id === state.current },
  })

  return <ItemContext.Provider value={conversation}>{element}</ItemContext.Provider>
}

export declare namespace Item {
  var MissingError: typeof MissingItemError

  type State = { current: boolean }

  type Props = useRender.ComponentProps<'li', State> & {
    conversation: Conversation.Conversation
  }
}

class MissingItemError extends Error {
  override readonly name = 'Conversations.Item.MissingError'

  constructor() {
    super('Render this part inside Conversations.Item.')
  }
}

Item.MissingError = MissingItemError

export function Select(props: Select.Props) {
  const { children, render, ...rest } = props
  const client = useClient()
  const state = useConversations()
  const conversation = useItem()
  const title = conversation.title || 'New chat'

  return useRender({
    defaultTagName: 'button',
    props: mergeProps(styles.select(), rest, {
      'aria-current': conversation.id === state.current ? ('true' as const) : undefined,
      children: children ?? title,
      disabled: state.status === 'locked',
      onClick: () => client.conversation.select({ id: conversation.id }),
      title,
      type: 'button',
    }),
    render,
  })
}

export declare namespace Select {
  type Props = useRender.ComponentProps<'button'>
}

export function Remove(props: Remove.Props) {
  const { children, render, ...rest } = props
  const client = useClient()
  const state = useConversations()
  const conversation = useItem()

  return useRender({
    defaultTagName: 'button',
    props: mergeProps(Skin.attachmentRemove(), styles.remove(), rest, {
      'aria-label': `Delete ${conversation.title || 'New chat'}`,
      children: children ?? '×',
      disabled: state.status === 'locked' && conversation.id === state.current,
      onClick: () => client.conversation.remove({ id: conversation.id }),
      type: 'button',
    }),
    render,
  })
}

export declare namespace Remove {
  type Props = useRender.ComponentProps<'button'>
}

export const styles = {
  item: style({
    alignItems: 'baseline',
    display: 'flex',
    gap: 'cell',
    minWidth: '0',
    '&[data-current]': { color: 'accent', fontVariationSettings: '"wght" 700' },
  }),
  list: style({
    display: 'flex',
    flexDirection: 'column',
    listStyle: 'none',
    margin: '0',
    minHeight: '0',
    overflowY: 'auto',
    padding: '0',
  }),
  new: style({
    alignSelf: 'flex-start',
    backgroundColor: 'transparent',
    border: 'none',
    color: 'accent',
    cursor: 'pointer',
    font: 'inherit !custom',
    padding: '0',
    textDecoration: 'none',
    ':disabled': { cursor: 'default', opacity: 'faint' },
    ':focus-visible': { outline: '1px solid', outlineColor: 'text', outlineOffset: '1px' },
    ':hover:not(:disabled)': { textDecorationColor: 'accent', textDecorationLine: 'underline' },
  }),
  remove: style({
    ':disabled': { cursor: 'default', opacity: 'faint' },
    ':focus-visible': { outline: '1px solid', outlineColor: 'text', outlineOffset: '1px' },
  }),
  root: style({
    display: 'flex',
    flexDirection: 'column',
    gap: 'sm',
    minHeight: '0',
    minWidth: '0',
    paddingBlock: 'sm',
    paddingInline: 'md',
  }),
  select: style({
    backgroundColor: 'transparent',
    border: 'none',
    color: 'inherit !custom',
    cursor: 'pointer',
    flex: '1 !custom',
    font: 'inherit !custom',
    minWidth: '0',
    overflow: 'hidden',
    padding: '0',
    textAlign: 'left',
    textDecoration: 'none',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':disabled': { cursor: 'default', opacity: 'faint' },
    ':focus-visible': { outline: '1px solid', outlineColor: 'text', outlineOffset: '1px' },
    ':hover:not(:disabled)': { textDecorationColor: 'accent', textDecorationLine: 'underline' },
  }),
}
