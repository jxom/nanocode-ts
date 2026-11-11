'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { createContext, useContext } from 'react'
import type * as Messages from '../client/Message.ts'
import { AttachmentList } from '../react/Attachments.tsx'
import * as Skin from './internal/Skin.ts'
import * as Reasoning from './Reasoning.tsx'
import { Response } from './Response.tsx'
import * as Tool from './Tool.tsx'

const Context = createContext<Messages.Message['role'] | undefined>(undefined)

export function Root(props: Root.Props) {
  const { from, render, steer = false, ...rest } = props
  const element = useRender({
    defaultTagName: 'div',
    props: mergeProps(Skin.turn(), rest),
    render,
    state: { role: from, steer },
  })

  return <Context.Provider value={from}>{element}</Context.Provider>
}

export declare namespace Root {
  type State = { role: Messages.Message['role']; steer: boolean }

  type Props = useRender.ComponentProps<'div', State> & {
    from: Messages.Message['role']
    steer?: boolean | undefined
  }
}

export function Author(props: Author.Props) {
  const { render, ...rest } = props
  const role = useContext(Context)
  if (!role) throw new Author.MissingError()
  const who = role === 'user' ? 'you' : 'agent'

  return useRender({
    defaultTagName: 'p',
    props: mergeProps(Skin.speaker({ who }), rest, {
      children: (
        <>
          <span aria-hidden="true">●</span> {who}
        </>
      ),
    }),
    render,
  })
}

export declare namespace Author {
  var MissingError: typeof MissingMessageError

  type Props = Omit<useRender.ComponentProps<'p'>, 'children'>
}

class MissingMessageError extends Error {
  override readonly name = 'Message.MissingError'

  constructor() {
    super('Render this part inside Message.Root.')
  }
}

Author.MissingError = MissingMessageError

export function Parts(props: Parts.Props) {
  const message = props.message

  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}:${index}`
        if (part.type === 'tool')
          return (
            <div key={key} {...Skin.entry({ kind: 'cell' })}>
              <Tool.Cell cell={part.tool} />
            </div>
          )
        if (part.type === 'reasoning')
          return (
            <Reasoning.Root key={key} part={part}>
              <Reasoning.Trigger />
              <Reasoning.Content />
            </Reasoning.Root>
          )
        if (part.type === 'error')
          return (
            <p key={key} {...Skin.entry({ kind: 'error' })}>
              {part.text}
            </p>
          )
        if (message.role === 'assistant')
          return (
            <Response key={key} state={part.state}>
              {part.text}
            </Response>
          )
        return (
          <p key={key} {...Skin.entry({ kind: 'user' })}>
            {part.text}
          </p>
        )
      })}
      {message.attachments?.length ? <AttachmentList items={message.attachments} /> : null}
    </>
  )
}

export declare namespace Parts {
  type Props = { message: Messages.Message }
}
