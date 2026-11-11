'use client'

import { Collapsible } from '@base-ui/react/collapsible'
import { createContext, useContext, useState } from 'react'
import * as Format from '../client/internal/Format.ts'
import type * as Message from '../client/Message.ts'
import { Markdown } from '../react/Markdown.tsx'
import { spinner, useNow } from '../react/ToolCell.tsx'
import * as Skin from './internal/Skin.ts'
import * as Tool from './Tool.tsx'

type Reasoning = Extract<Message.Part, { type: 'reasoning' }>

const Context = createContext<Reasoning | undefined>(undefined)

function useReasoning(): Reasoning {
  const part = useContext(Context)
  if (!part) throw new Root.MissingError()
  return part
}

export function Root(props: Root.Props) {
  const { className, part, ...rest } = props
  const [open, setOpen] = useState(false)
  const state = part.state === 'streaming' ? 'streaming' : open ? 'open' : 'closed'

  return (
    <Context.Provider value={part}>
      <Collapsible.Root
        {...rest}
        data-state={state}
        onOpenChange={setOpen}
        open={state !== 'closed'}
        {...styles.root({ className })}
      />
    </Context.Provider>
  )
}

export declare namespace Root {
  var MissingError: typeof MissingReasoningError

  type State = { state: 'closed' | 'open' | 'streaming' }

  type Props = Omit<Collapsible.Root.Props, 'className' | 'onOpenChange' | 'open' | 'part'> & {
    className?: string | undefined
    part: Reasoning
  }
}

class MissingReasoningError extends Error {
  override readonly name = 'Reasoning.MissingError'

  constructor() {
    super('Render this part inside Reasoning.Root.')
  }
}

Root.MissingError = MissingReasoningError

export function Trigger(props: Trigger.Props) {
  const { className, ...rest } = props
  const part = useReasoning()
  const live = part.state === 'streaming'
  const now = useNow(live)
  const label = (() => {
    if (part.state === 'streaming') return 'Thinking'
    if (part.durationMs === undefined) return 'Thought'
    return 'Thought for ' + Format.duration(part.durationMs)
  })()

  return (
    <Collapsible.Trigger {...rest} {...styles.trigger({ className })}>
      <span aria-hidden="true" {...Skin.icon({ status: live ? 'running' : 'completed' })}>
        {live ? spinner[Math.floor(now / 120) % spinner.length] : '✻'}
      </span>
      <span {...Skin.name()}>{label}</span>
    </Collapsible.Trigger>
  )
}

export declare namespace Trigger {
  type Props = Omit<Collapsible.Trigger.Props, 'children' | 'className'> & {
    className?: string | undefined
  }
}

export function Content(props: Content.Props) {
  const { className, ...rest } = props
  const part = useReasoning()
  const live = part.state === 'streaming'

  return (
    <Collapsible.Panel {...rest} {...styles.content({ className, live })}>
      <Markdown live={live} text={part.text} />
    </Collapsible.Panel>
  )
}

export declare namespace Content {
  type Props = Omit<Collapsible.Panel.Props, 'children' | 'className'> & {
    className?: string | undefined
  }
}

export const styles = {
  content: (state: { className?: string | undefined; live: boolean }) =>
    Skin.entry({ className: state.className, kind: 'reasoning', live: state.live }),
  root: Tool.styles.root,
  trigger: Tool.styles.trigger,
}
