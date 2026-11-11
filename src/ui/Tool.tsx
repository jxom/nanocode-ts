'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import { createContext, type ReactNode, useContext, useState } from 'react'
import * as Format from '../client/internal/Format.ts'
import type * as ToolCell from '../client/Tool.ts'
import { Tokens } from '../react/Code.tsx'
import { Image } from '../react/Image.tsx'
import { spinner, useNow } from '../react/ToolCell.tsx'
import * as Skin from './internal/Skin.ts'

const icons: Record<ToolCell.Cell['status'], string> = {
  cancelled: '⊘',
  completed: '✓',
  failed: '✗',
  running: spinner[0]!,
  yielded: '↻',
}

const inputLines = 12

const outputLines = 10

type Context = {
  cell: ToolCell.Cell
  nested: boolean
  open: boolean
  setOpen(open: boolean): void
}

const Context = createContext<Context | undefined>(undefined)

function useTool(): Context {
  const context = useContext(Context)
  if (!context) throw new Root.MissingError()
  return context
}

export function Cell(props: Cell.Props) {
  return (
    <Root cell={props.cell} nested={props.nested}>
      <Trigger />
      <Input />
      <Children />
      <Output />
      <Images />
    </Root>
  )
}

export declare namespace Cell {
  type Props = {
    cell: ToolCell.Cell
    nested?: boolean | undefined
  }
}

export function Root(props: Root.Props) {
  const { cell, nested = false, render, ...rest } = props
  const [open, setOpen] = useState(false)
  const element = useRender({
    defaultTagName: 'div',
    props: mergeProps(styles.root(), rest, {
      'data-call': cell.call_id,
    }),
    render,
    state: { nested, open, status: cell.status },
  })

  return <Context.Provider value={{ cell, nested, open, setOpen }}>{element}</Context.Provider>
}

export declare namespace Root {
  var MissingError: typeof MissingToolError

  type State = { nested: boolean; open: boolean; status: ToolCell.Cell['status'] }

  type Props = useRender.ComponentProps<'div', State> & {
    cell: ToolCell.Cell
    nested?: boolean | undefined
  }
}

class MissingToolError extends Error {
  override readonly name = 'Tool.MissingError'

  constructor() {
    super('Render this part inside Tool.Root.')
  }
}

Root.MissingError = MissingToolError

export function Trigger(props: Trigger.Props) {
  const { children, render, ...rest } = props
  const tool = useTool()
  const cell = tool.cell
  const running = cell.status === 'running'
  const now = useNow(running)
  const output = cell.output.replace(/\s+$/, '')
  const meta = [
    running
      ? Format.duration(now - cell.started_at)
      : cell.duration_ms === undefined
        ? undefined
        : Format.duration(cell.duration_ms),
    cell.status === 'cancelled' || cell.status === 'failed' ? cell.status : undefined,
    ...cell.details,
    tool.nested && !tool.open && !running && output ? lineCount(output) : undefined,
  ].filter((item) => item !== undefined)

  return useRender({
    defaultTagName: 'button',
    props: mergeProps(styles.trigger(), rest, {
      'aria-expanded': tool.open,
      children: children ?? (
        <>
          <Icon />
          <Name />
          {cell.title && <span {...Skin.title()}>{cell.title}</span>}
          <span {...Skin.meta()}>{meta.map((item) => ` · ${item}`).join('')}</span>
        </>
      ),
      onClick: () => tool.setOpen(!tool.open),
      type: 'button',
    }),
    render,
  })
}

export declare namespace Trigger {
  type Props = useRender.ComponentProps<'button'>
}

export function Icon(props: Icon.Props) {
  const { render, ...rest } = props
  const status = useTool().cell.status
  const now = useNow(status === 'running')

  return useRender({
    defaultTagName: 'span',
    props: mergeProps(Skin.icon({ status }), rest, {
      'aria-label': status,
      children:
        status === 'running' ? spinner[Math.floor(now / 120) % spinner.length] : icons[status],
    }),
    render,
    state: { status },
  })
}

export declare namespace Icon {
  type Props = Omit<useRender.ComponentProps<'span', State>, 'children'>

  type State = { status: ToolCell.Cell['status'] }
}

export function Name(props: Name.Props) {
  const { render, ...rest } = props
  const name = useTool().cell.name

  return useRender({
    defaultTagName: 'span',
    props: mergeProps(Skin.name(), rest, { children: name }),
    render,
  })
}

export declare namespace Name {
  type Props = Omit<useRender.ComponentProps<'span'>, 'children'>
}

export function Input(props: Input.Props) {
  const tool = useTool()
  const cell = tool.cell
  const input = cell.input.replace(/\s+$/, '')
  if (!input || (tool.nested && !tool.open && cell.body !== 'diff')) return null

  return (
    <Section
      {...props}
      language={cell.body === 'diff' ? 'diff' : cell.language}
      limit={tool.open ? Infinity : inputLines}
      part="input"
      text={input}
    />
  )
}

export declare namespace Input {
  type Props = { className?: string | undefined }
}

export function Output(props: Output.Props) {
  const tool = useTool()
  const cell = tool.cell
  const output = cell.output.replace(/\s+$/, '')
  const failed = cell.status === 'failed' || (cell.exit_code !== undefined && cell.exit_code !== 0)
  if (!output || (tool.nested && !tool.open && !failed)) return null

  return (
    <Section
      {...props}
      language={cell.output_language}
      limit={tool.open ? Infinity : outputLines}
      part={failed ? 'error' : 'output'}
      text={output}
    />
  )
}

export declare namespace Output {
  type Props = { className?: string | undefined }
}

export function Children(props: Children.Props) {
  const children = useTool().cell.children
  if (!children.length) return null

  return (
    <div {...Skin.children({ className: props.className })}>
      {children.map((child) => (
        <Cell cell={child} key={child.call_id} nested />
      ))}
    </div>
  )
}

export declare namespace Children {
  type Props = { className?: string | undefined }
}

export function Images(props: Images.Props) {
  const tool = useTool()
  const images = tool.cell.images ?? []
  if (!images.length) return null

  return (
    <div {...Skin.images({ className: props.className })}>
      {images.map((src, index) => (
        <Image alt={`${tool.cell.name} image ${index + 1}`} key={index} src={src} />
      ))}
    </div>
  )
}

export declare namespace Images {
  type Props = { className?: string | undefined }
}

function Section(props: Section.Props) {
  const tool = useTool()
  const running = tool.cell.status === 'running'
  const lines = props.text.split('\n')
  const size = tool.open ? 'full' : tool.nested ? 'nested' : 'normal'
  const body = (text: string) => (
    <pre
      data-language={props.language}
      {...Skin.body({ className: props.className, part: props.part, size })}
    >
      <Tokens code={text} language={props.language} />
    </pre>
  )
  if (lines.length <= props.limit) return body(props.text)

  const hidden = lines.length - props.limit
  const more: ReactNode = (
    <button onClick={() => tool.setOpen(true)} type="button" {...Skin.more()}>
      {running ? `… ${hidden} earlier lines` : `… ${hidden} more lines`}
    </button>
  )

  return (
    <div {...Skin.section()}>
      {running && more}
      {body((running ? lines.slice(-props.limit) : lines.slice(0, props.limit)).join('\n'))}
      {!running && more}
    </div>
  )
}

declare namespace Section {
  type Props = {
    className?: string | undefined
    language: string
    limit: number
    part: 'error' | 'input' | 'output'
    text: string
  }
}

function lineCount(text: string): string {
  const lines = text.split('\n').length
  return lines === 1 ? '1 line' : lines.toLocaleString('en-US') + ' lines'
}

export const styles = {
  root: style({ display: 'flex', flexDirection: 'column', minWidth: '0' }),
  trigger: Skin.header,
}
