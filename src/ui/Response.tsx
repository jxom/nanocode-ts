'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { Markdown } from '../react/Markdown.tsx'
import * as Skin from './internal/Skin.ts'

export function Response(props: Response.Props) {
  const { children, render, state = 'done', ...rest } = props

  return useRender({
    defaultTagName: 'div',
    props: mergeProps(styles.response({ live: state === 'streaming' }), rest, {
      children: <Markdown live={state === 'streaming'} text={children} />,
    }),
    render,
    state: { state },
  })
}

export declare namespace Response {
  type State = { state: 'done' | 'streaming' }

  type Props = Omit<useRender.ComponentProps<'div', State>, 'children'> & {
    children: string
    state?: State['state'] | undefined
  }
}

export const styles = {
  response: (state: { live: boolean }) => Skin.entry({ kind: 'assistant', live: state.live }),
}
