'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { useChat } from '../react/Hooks.ts'
import * as Skin from './internal/Skin.ts'

export function Root(props: Root.Props) {
  const { render, ...rest } = props

  return useRender({ defaultTagName: 'div', props: mergeProps(Skin.suggestions(), rest), render })
}

export declare namespace Root {
  type Props = useRender.ComponentProps<'div'>
}

export function Item(props: Item.Props) {
  const { children, render, suggestion, ...rest } = props
  const chat = useChat()
  const busy = chat.state.status === 'streaming' || chat.state.status === 'submitted'

  return useRender({
    defaultTagName: 'button',
    props: mergeProps(Skin.suggestion(), rest, {
      children: children ?? suggestion,
      disabled: busy,
      onClick: () => void chat.sendMessage({ text: suggestion }),
      type: 'button',
    }),
    render,
  })
}

export declare namespace Item {
  type Props = useRender.ComponentProps<'button'> & { suggestion: string }
}
