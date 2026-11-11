export type Storage = {
  getItem(name: string): string | null
  key: string
  removeItem(name: string): void
  setItem(name: string, value: string): void
}

type Store = Omit<Storage, 'key'>

export function from(options: from.Options): Storage {
  const { getItem, key, removeItem, setItem } = options
  return { getItem, key, removeItem, setItem }
}

export declare namespace from {
  type Options = Storage
}

export function local(options: local.Options = {}): Storage {
  const { key = 'nanocode' } = options
  const store = (globalThis as { localStorage?: Store }).localStorage
  if (!store) throw new UnavailableError()
  return {
    getItem: (name) => store.getItem(name),
    key,
    removeItem: (name) => store.removeItem(name),
    setItem: (name, value) => store.setItem(name, value),
  }
}

export declare namespace local {
  type Options = {
    key?: string | undefined
  }

  type ErrorType = UnavailableError
}

export function memory(options: memory.Options = {}): Storage {
  const { key = 'nanocode' } = options
  const values = new Map<string, string>()
  return {
    getItem: (name) => values.get(name) ?? null,
    key,
    removeItem: (name) => {
      values.delete(name)
    },
    setItem: (name, value) => {
      values.set(name, value)
    },
  }
}

export declare namespace memory {
  type Options = {
    key?: string | undefined
  }
}

export class UnavailableError extends Error {
  override readonly name = 'Storage.UnavailableError'

  constructor() {
    super('localStorage is not available in this runtime. Pass Storage.memory() or Storage.from().')
  }
}
