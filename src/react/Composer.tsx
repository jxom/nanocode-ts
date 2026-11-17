'use client'

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import type * as Transport from '../client/Transport.ts'
import { AttachmentList, type Attachments, useAttachments } from './Attachments.tsx'
import { ConfigContext, usePart } from './Provider.tsx'

export type ComposerModel = { id: string; label: string; detail?: string | undefined }

export type ComposerMenu =
  | { open: false }
  | { open: true; view: 'settings' | 'models'; active: number }

export type ComposerItem =
  | { kind: 'attach'; label: string; disabled: boolean }
  | { kind: 'models'; label: string; detail: string | undefined }
  | { kind: 'model'; model: ComposerModel; selected: boolean }

export type Composer = {
  prompt: string
  setPrompt(prompt: string): void
  attachments: Attachments
  models: readonly ComposerModel[]
  model: ComposerModel | undefined
  selectModel(id: string): void
  menu: ComposerMenu
  items: readonly ComposerItem[]
  openMenu(view?: 'settings' | 'models'): void
  closeMenu(): void
  choose(index: number): void
  canSubmit: boolean
  submit(): void
  trigger: {
    ref: { current: HTMLButtonElement | null }
    'aria-controls': string
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
    onClick(): void
    onKeyDown(event: KeyboardEvent): void
  }
  chip: {
    'aria-controls': string
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
    onClick(): void
  }
  list: {
    id: string
    ref: { current: HTMLDivElement | null }
    role: 'menu'
    tabIndex: -1
    onKeyDown(event: KeyboardEvent): void
  }
  item(index: number): {
    id: string
    role: 'menuitem' | 'menuitemradio'
    'aria-checked'?: boolean
    'aria-disabled'?: boolean
    tabIndex: -1
    onClick(): void
    onPointerEnter(): void
  }
}

export function useComposer(options: useComposer.Options = {}): Composer {
  const attachments = useAttachments({
    ...(options.maxAttachments !== undefined ? { max: options.maxAttachments } : {}),
    ...(options.accept ? { accept: options.accept } : {}),
    ...(options.files ? { files: options.files } : {}),
  })
  const config = useContext(ConfigContext)
  const models = options.models ?? []
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState(options.defaultModel)
  const [menu, setMenu] = useState<ComposerMenu>({ open: false })
  const id = useId()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const selected = options.model ?? picked
  const model = models.find((entry) => entry.id === selected) ?? models[0]

  const items: ComposerItem[] = !menu.open
    ? []
    : menu.view === 'models'
      ? models.map((entry) => ({ kind: 'model', model: entry, selected: entry.id === model?.id }))
      : [
          ...(attachments.enabled
            ? [
                {
                  kind: 'attach' as const,
                  label: 'Add attachment',
                  disabled: attachments.items.length >= attachments.max,
                },
              ]
            : []),
          ...(models.length > 1
            ? [{ kind: 'models' as const, label: 'Model', detail: model?.label }]
            : []),
        ]

  const closeMenu = useCallback(() => {
    setMenu({ open: false })
    trigger.current?.focus()
  }, [])

  const openMenu = useCallback(
    (view: 'settings' | 'models' = 'settings') => {
      const start =
        view === 'models'
          ? Math.max(
              0,
              models.findIndex((entry) => entry.id === model?.id),
            )
          : 0
      setMenu({ open: true, view, active: start })
    },
    [models, model?.id],
  )

  useEffect(() => {
    if (menu.open) list.current?.focus()
  }, [menu.open, menu.open && menu.view])

  useEffect(() => {
    if (!menu.open) return
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (list.current?.contains(target) || trigger.current?.contains(target)) return
      setMenu({ open: false })
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu.open])

  const selectModel = (next: string) => {
    if (options.model === undefined) setPicked(next)
    options.onModelChange?.(next)
  }

  const choose = (index: number) => {
    const item = items[index]
    if (!item) return
    switch (item.kind) {
      case 'attach':
        if (item.disabled) return
        setMenu({ open: false })
        attachments.open()
        return
      case 'models':
        setMenu({
          open: true,
          view: 'models',
          active: Math.max(
            0,
            models.findIndex((entry) => entry.id === model?.id),
          ),
        })
        return
      case 'model':
        selectModel(item.model.id)
        closeMenu()
        return
      default:
        return item satisfies never
    }
  }

  const move = (event: KeyboardEvent) => {
    if (!menu.open) return
    const last = items.length - 1
    const step = (active: number) => setMenu({ ...menu, active })
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        return step(menu.active >= last ? 0 : menu.active + 1)
      case 'ArrowUp':
        event.preventDefault()
        return step(menu.active <= 0 ? last : menu.active - 1)
      case 'Home':
        event.preventDefault()
        return step(0)
      case 'End':
        event.preventDefault()
        return step(last)
      case 'Enter':
      case ' ':
        event.preventDefault()
        return choose(menu.active)
      case 'ArrowLeft':
      case 'Backspace':
        if (menu.view !== 'models') return
        event.preventDefault()
        return setMenu({ open: true, view: 'settings', active: 0 })
      case 'Escape':
      case 'Tab':
        if (event.key === 'Escape') event.preventDefault()
        return closeMenu()
      default:
        return
    }
  }

  const text = prompt.trim()
  const canSubmit =
    !options.disabled && !attachments.uploading && Boolean(text || attachments.ready.length)

  const submit = () => {
    if (!canSubmit) return
    const ready = attachments.ready
    if (options.onSubmit) options.onSubmit({ prompt: text, attachments: ready, model: model?.id })
    else void config?.send(text, ready)
    setPrompt('')
    attachments.clear()
  }

  const listId = id + '-menu'
  const expanded = menu.open
  return {
    prompt,
    setPrompt,
    attachments,
    models,
    model,
    selectModel,
    menu,
    items,
    openMenu,
    closeMenu,
    choose,
    canSubmit,
    submit,
    trigger: {
      ref: trigger,
      'aria-controls': listId,
      'aria-expanded': expanded,
      'aria-haspopup': 'menu',
      onClick: () => (menu.open ? closeMenu() : openMenu('settings')),
      onKeyDown: (event) => {
        if (menu.open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
        event.preventDefault()
        openMenu('settings')
      },
    },
    chip: {
      'aria-controls': listId,
      'aria-expanded': expanded && menu.view === 'models',
      'aria-haspopup': 'menu',
      onClick: () => (menu.open && menu.view === 'models' ? closeMenu() : openMenu('models')),
    },
    list: { id: listId, ref: list, role: 'menu', tabIndex: -1, onKeyDown: move },
    item: (index) => {
      const item = items[index]
      return {
        id: listId + '-' + index,
        role: item?.kind === 'model' ? 'menuitemradio' : 'menuitem',
        ...(item?.kind === 'model' ? { 'aria-checked': item.selected } : {}),
        ...(item?.kind === 'attach' && item.disabled ? { 'aria-disabled': true } : {}),
        tabIndex: -1,
        onClick: () => choose(index),
        onPointerEnter: () => menu.open && setMenu({ ...menu, active: index }),
      }
    },
  }
}

export declare namespace useComposer {
  type Options = {
    models?: readonly ComposerModel[] | undefined
    model?: string | undefined
    defaultModel?: string | undefined
    onModelChange?(id: string): void
    onSubmit?(turn: Submission): void
    maxAttachments?: number | undefined
    accept?: readonly string[] | undefined
    files?: Transport.Files | undefined
    disabled?: boolean | undefined
  }
  type Submission = {
    prompt: string
    attachments: readonly Transport.Attachment[]
    model: string | undefined
  }
}

export function Composer(props: Composer.Props) {
  const part = usePart()
  const composer = useComposer(props)
  const { attachments, menu } = composer
  const input = useRef<HTMLTextAreaElement | null>(null)
  const state = composer.menu.open ? composer.menu.view : 'closed'
  return (
    <form
      aria-label={props.label ?? 'Message'}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        composer.submit()
      }}
      {...attachments.drop}
      {...part('composer', { dragging: attachments.dragging, menu: state })}
    >
      <AttachmentList items={attachments.items} onRemove={attachments.remove} />
      <textarea
        aria-label="Prompt"
        disabled={props.disabled}
        onChange={(event) => composer.setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          composer.submit()
        }}
        onPaste={attachments.onPaste}
        placeholder={props.placeholder ?? 'Ask anything'}
        ref={input}
        rows={Math.min(8, Math.max(1, composer.prompt.split('\n').length))}
        value={composer.prompt}
        {...part('input')}
      />
      <div {...part('composerToolbar')}>
        <input {...attachments.input} />
        <button
          aria-label="Settings: add attachment or choose model"
          type="button"
          {...composer.trigger}
          {...part('settings', { open: menu.open && menu.view === 'settings' })}
        >
          +
        </button>
        {composer.models.length > 0 && (
          <button
            aria-label={'Model: ' + (composer.model?.label ?? '')}
            disabled={composer.models.length < 2}
            type="button"
            {...composer.chip}
            {...part('modelChip', { open: menu.open && menu.view === 'models' })}
          >
            {composer.model?.label}
          </button>
        )}
        {props.children}
        <button
          aria-label="Send"
          disabled={!composer.canSubmit}
          type="submit"
          {...part('send', { ready: composer.canSubmit })}
        >
          {props.sendLabel ?? '↑'}
        </button>
      </div>
      {menu.open && (
        <div
          aria-activedescendant={composer.item(menu.active).id}
          aria-label={menu.view === 'models' ? 'Models' : 'Settings'}
          {...composer.list}
          {...part('settingsMenu', { view: menu.view })}
        >
          {composer.items.map((item, index) => (
            <div
              key={item.kind === 'model' ? item.model.id : item.kind}
              {...composer.item(index)}
              {...part('settingsItem', {
                active: index === menu.active,
                kind: item.kind,
                selected: item.kind === 'model' ? item.selected : undefined,
                disabled: item.kind === 'attach' ? item.disabled : undefined,
              })}
            >
              <span {...part('settingsLabel')}>
                {item.kind === 'model' ? item.model.label : item.label}
              </span>
              {item.kind === 'model' && item.model.detail && (
                <span {...part('settingsDetail')}>{item.model.detail}</span>
              )}
              {item.kind === 'models' && item.detail && (
                <span {...part('settingsDetail')}>{item.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </form>
  )
}

export declare namespace Composer {
  type Props = useComposer.Options & {
    label?: string | undefined
    placeholder?: string | undefined
    sendLabel?: ReactNode
    children?: ReactNode
  }
}
