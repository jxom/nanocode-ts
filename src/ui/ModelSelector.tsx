'use client'

import { Combobox } from '@base-ui/react/combobox'
import { Menu as BaseMenu } from '@base-ui/react/menu'
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { style } from 'nds'
import { Menu } from 'nds/react'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import type * as Model from '../client/Model.ts'
import type * as Payer from '../client/Payer.ts'
import { useClient, useEvent } from '../react/Hooks.ts'
import * as Skin from './internal/Skin.ts'

export type Choice = { model: Model.Model; payer: Payer.Payer }

type Context = { groups: readonly Group.Value[]; model: Model.State }

const Context = createContext<Context | undefined>(undefined)

function useModelSelector(): Context {
  const context = useContext(Context)
  if (!context) throw new Root.MissingError()
  return context
}

export function Root(props: Root.Props) {
  const { render, ...rest } = props
  const client = useClient()
  const conversation = useEvent('conversation')
  const model = useEvent('model')
  const payer = useEvent('payer')

  const groups = useMemo(() => {
    const ready = payer.payers.flatMap((entry) => (entry.status === 'ready' ? [entry] : []))
    return ready.flatMap((entry) =>
      entry.harnesses.map((harness) => ({
        harness,
        items: harness.models.map((candidate) => ({ model: candidate, payer: entry })),
        label: ready.length > 1 ? `${entry.label} · ${harness.label}` : harness.label,
        payer: entry,
        value: `${entry.id}:${harness.id}`,
      })),
    )
  }, [payer])

  const value = useMemo(
    () => (model.status === 'ready' ? { model: model.current, payer: payer.current } : null),
    [model, payer],
  )

  const choose = (choice: Choice | null) => {
    if (!choice) return
    if (choice.payer.id !== payer.current.id) client.payer.select({ id: choice.payer.id })
    client.model.select({ id: choice.model.id })
  }

  const element = useRender({
    defaultTagName: 'div',
    props: mergeProps(styles.root(), rest, {
      'aria-busy': model.status === 'loading',
      'aria-live': 'polite' as const,
    }),
    render,
    state: { status: model.status },
  })

  return (
    <Context.Provider value={{ groups, model }}>
      <Combobox.Root
        disabled={conversation.status === 'locked' || groups.length === 0}
        filter={matches}
        isItemEqualToValue={same}
        itemToStringLabel={(choice: Choice) => choice.model.name}
        items={groups}
        onValueChange={choose}
        value={value}
      >
        {element}
      </Combobox.Root>
    </Context.Provider>
  )
}

export declare namespace Root {
  var MissingError: typeof MissingModelSelectorError

  type State = { status: Model.State['status'] }

  type Props = useRender.ComponentProps<'div', State>
}

class MissingModelSelectorError extends Error {
  override readonly name = 'ModelSelector.MissingError'

  constructor() {
    super('Render this part inside ModelSelector.Root.')
  }
}

Root.MissingError = MissingModelSelectorError

export function Trigger(props: Trigger.Props) {
  const { children, className, ...rest } = props
  const model = useModelSelector().model
  const label = (() => {
    if (model.status === 'loading') return 'Loading models…'
    if (model.status === 'failed') return model.error.message
    return model.current.name
  })()

  return (
    <Combobox.Trigger
      {...rest}
      {...Skin.header({ className: styles.trigger({ className }).className })}
    >
      {children ?? (
        <>
          <span {...Skin.title()}>{label}</span>
          <span aria-hidden="true" {...Skin.marker()}>
            {' ▾'}
          </span>
        </>
      )}
    </Combobox.Trigger>
  )
}

export declare namespace Trigger {
  type Props = Omit<Combobox.Trigger.Props, 'className'> & { className?: string | undefined }
}

export function Thinking(props: Thinking.Props) {
  const { className, ...rest } = props
  const client = useClient()
  const model = useModelSelector().model
  if (model.status !== 'ready' || !model.current.efforts.length) return null

  const current = model.current

  return (
    <Menu.Root>
      <BaseMenu.Trigger {...rest} {...Skin.header({ className })}>
        <span {...Skin.meta()}>thinking {model.thinking}</span>
        <span aria-hidden="true" {...Skin.marker()}>
          {' ▾'}
        </span>
      </BaseMenu.Trigger>
      <Menu.Popup align="start" className={styles.popup().className}>
        <BaseMenu.RadioGroup {...styles.group()} value={model.thinking}>
          {current.efforts.map((effort) => (
            <BaseMenu.RadioItem
              closeOnClick
              key={effort}
              onClick={() => client.model.setThinking({ thinking: effort })}
              value={effort}
              {...Skin.choice({ className: styles.item().className })}
            >
              <Marks detail={effort === current.effort ? 'default' : ''} label={effort} />
            </BaseMenu.RadioItem>
          ))}
        </BaseMenu.RadioGroup>
      </Menu.Popup>
    </Menu.Root>
  )
}

export declare namespace Thinking {
  type Props = Omit<BaseMenu.Trigger.Props, 'children' | 'className'> & {
    className?: string | undefined
  }
}

export function Popup(props: Popup.Props) {
  const { align = 'start', children, className, side, sideOffset, ...rest } = props
  useModelSelector()

  return (
    <Combobox.Portal>
      <Combobox.Positioner
        {...Menu.styles.positioner()}
        align={align}
        {...(side ? { side } : {})}
        {...(sideOffset === undefined ? {} : { sideOffset })}
      >
        <Combobox.Popup
          aria-label="Models"
          {...rest}
          {...Menu.styles.popup({ className: styles.popup({ className }).className })}
        >
          {children ?? (
            <>
              <Search />
              <Empty />
              <List />
            </>
          )}
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  )
}

export declare namespace Popup {
  type Props = Omit<Combobox.Popup.Props, 'className'> &
    Pick<Combobox.Positioner.Props, 'align' | 'side' | 'sideOffset'> & {
      className?: string | undefined
    }
}

export function Search(props: Search.Props) {
  const { className, ...rest } = props
  useModelSelector()

  return (
    <Combobox.Input
      aria-label="Filter models"
      placeholder="filter"
      {...rest}
      {...styles.search({ className })}
    />
  )
}

export declare namespace Search {
  type Props = Omit<Combobox.Input.Props, 'className'> & { className?: string | undefined }
}

export function Empty(props: Empty.Props) {
  const { children, className, ...rest } = props
  useModelSelector()

  return (
    <Combobox.Empty {...rest} {...Skin.pickerMuted({ className })}>
      {children ?? 'no matches'}
    </Combobox.Empty>
  )
}

export declare namespace Empty {
  type Props = Omit<Combobox.Empty.Props, 'className'> & { className?: string | undefined }
}

export function List(props: List.Props) {
  const { children, className, ...rest } = props
  useModelSelector()

  return (
    <Combobox.List {...rest} {...styles.list({ className })}>
      {(group: Group.Value) =>
        children ? children(group) : <Group group={group} key={group.value} />
      }
    </Combobox.List>
  )
}

export declare namespace List {
  type Props = Omit<Combobox.List.Props, 'children' | 'className'> & {
    children?: ((group: Group.Value) => ReactNode) | undefined
    className?: string | undefined
  }
}

export function Group(props: Group.Props) {
  const { children, className, group, ...rest } = props
  useModelSelector()

  return (
    <Combobox.Group {...rest} items={group.items} {...styles.group({ className })}>
      <Combobox.GroupLabel {...Skin.pickerHeader({ className: styles.label().className })}>
        {group.label}
      </Combobox.GroupLabel>
      <Combobox.Collection>
        {(choice: Choice) =>
          children ? children(choice) : <Item choice={choice} key={choice.model.id} />
        }
      </Combobox.Collection>
    </Combobox.Group>
  )
}

export declare namespace Group {
  type Props = Omit<Combobox.Group.Props, 'children' | 'className' | 'items'> & {
    children?: ((choice: Choice) => ReactNode) | undefined
    className?: string | undefined
    group: Value
  }

  type Value = {
    harness: Model.Harness
    items: readonly Choice[]
    label: string
    payer: Payer.Payer
    value: string
  }
}

export function Item(props: Item.Props) {
  const { children, choice, className, ...rest } = props
  useModelSelector()
  const model = choice.model
  const detail = [
    model.name === model.id ? undefined : model.name,
    model.detail,
    model.efforts.length ? `thinking ${model.efforts.join('/')}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Combobox.Item
      {...rest}
      value={choice}
      {...Skin.choice({ className: styles.item({ className }).className })}
    >
      {children ?? <Marks detail={detail} label={model.id} />}
    </Combobox.Item>
  )
}

export declare namespace Item {
  type Props = Omit<Combobox.Item.Props, 'className' | 'value'> & {
    choice: Choice
    className?: string | undefined
  }
}

function Marks(props: Marks.Props) {
  return (
    <>
      <span aria-hidden="true" {...Skin.marker({ className: styles.pointer().className })}>
        ›
      </span>
      <span {...Skin.choiceLabel({ className: styles.checked().className })}>{props.label}</span>
      <span aria-hidden="true" {...Skin.marker({ className: styles.check().className })}>
        ✓
      </span>
      <span {...Skin.choiceDetail()}>{props.detail}</span>
    </>
  )
}

declare namespace Marks {
  type Props = { detail: string; label: string }
}

function matches(choice: Choice, query: string): boolean {
  const text = [choice.model.id, choice.model.name, choice.model.detail].join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}

function same(choice: Choice, value: Choice): boolean {
  return choice.model.id === value.model.id && choice.payer.id === value.payer.id
}

const root = style({ alignItems: 'baseline', display: 'inline-flex', gap: 'indent', minWidth: '0' })

export const styles = {
  check: style({
    visibility: 'hidden',
    selectors: { '[data-checked] > &, [data-selected] > &': { visibility: 'visible' } },
  }),
  checked: style({
    selectors: { '[data-checked] > &': { color: 'accent', fontVariationSettings: '"wght" 700' } },
  }),
  group: style({
    display: 'grid',
    gridTemplateColumns: '2ch max-content 2ch minmax(0, 1fr) !custom',
  }),
  item: style({
    gridColumn: '1 / -1 !custom',
    gridTemplateColumns: 'subgrid !custom',
    outline: 'none',
    '&[data-highlighted]': { backgroundColor: 'highlight' },
  }),
  label: style({ gridColumn: '1 / -1 !custom' }),
  list: style({ minHeight: '0', overflowY: 'auto' }),
  pointer: style({
    visibility: 'hidden',
    selectors: { '[data-highlighted] > &': { visibility: 'visible' } },
  }),
  popup: style({ maxWidth: 'var(--available-width) !custom', paddingInline: 'cell' }),
  root,
  search: style({
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: '1px solid',
    borderBottomColor: 'rule',
    color: 'text',
    font: 'inherit !custom',
    marginBottom: 'xs',
    paddingBlock: 'xs',
    ':focus-visible': { borderBottomColor: 'accent', outline: 'none' },
    '::placeholder': { color: 'middle' },
  }),
  trigger: style({
    ':disabled': { cursor: 'default' },
    selectors: { [`${root}[data-status="failed"] &`]: { color: 'accent' } },
  }),
}
