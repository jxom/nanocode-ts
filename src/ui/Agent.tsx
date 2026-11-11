'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import type { ReactNode } from 'react'
import { useChat, useClient } from '../react/Hooks.ts'
import * as Composer from './Composer.tsx'
import * as Connect from './Connect.tsx'
import * as Conversation from './Conversation.tsx'
import * as Message from './Message.tsx'
import * as ModelSelector from './ModelSelector.tsx'
import * as Skin from './internal/Skin.ts'
import * as Suggestions from './Suggestions.tsx'
import * as Wallet from './Wallet.tsx'

export function Agent(props: Agent.Props) {
  const { empty, footer, placeholder, prompts = [], render, title, ...rest } = props
  const chat = useChat()
  const client = useClient()

  return useRender({
    defaultTagName: 'section',
    props: mergeProps(styles.root(), rest, {
      'aria-label': title ?? 'Agent',
      children: (
        <>
          {title && <p {...styles.title()}>{title}</p>}
          <Conversation.Root>
            <Conversation.Content>
              {empty && <Conversation.Empty>{empty}</Conversation.Empty>}
              {chat.messages.map((message) => (
                <Message.Root from={message.role} key={message.id} steer={message.steer}>
                  <Message.Author />
                  <Message.Parts message={message} />
                </Message.Root>
              ))}
            </Conversation.Content>
            <Conversation.ScrollButton />
          </Conversation.Root>
          {prompts.length > 0 && (
            <Suggestions.Root>
              {prompts.map((prompt) => (
                <Suggestions.Item key={prompt} suggestion={prompt} />
              ))}
            </Suggestions.Root>
          )}
          <Connect.Root>
            <Composer.Root>
              <Composer.Attachments />
              <Composer.Input placeholder={placeholder} />
              <Composer.Footer>
                <Composer.Attach />
                <ModelSelector.Root>
                  <ModelSelector.Trigger />
                  <ModelSelector.Thinking />
                  <ModelSelector.Popup />
                </ModelSelector.Root>
                <Connect.Trigger />
                <Connect.Popup />
                <Composer.Stop />
                <Composer.Submit />
              </Composer.Footer>
            </Composer.Root>
            <Connect.Panel />
          </Connect.Root>
          {'tempo' in client && <Wallet.Meter />}
          {footer && <div {...Skin.status()}>{footer}</div>}
        </>
      ),
    }),
    render,
  })
}

export declare namespace Agent {
  type Props = Omit<useRender.ComponentProps<'section'>, 'children' | 'title'> & {
    empty?: ReactNode
    footer?: ReactNode
    placeholder?: string | undefined
    prompts?: readonly string[] | undefined
    title?: string | undefined
  }
}

export const styles = {
  root: style({
    backgroundColor: 'surface',
    border: '1px solid',
    borderColor: 'rule',
    color: 'text',
    display: 'flex',
    flexDirection: 'column',
    height: '32rem !custom',
  }),
  title: style({
    borderBottom: '1px solid',
    borderBottomColor: 'rule',
    fontVariationSettings: '"wght" 700',
    margin: '0',
    paddingBlock: 'xs',
    paddingInline: 'md',
  }),
}
