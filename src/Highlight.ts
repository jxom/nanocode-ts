export type Highlighter = (code: string, language: string) => Token[][]

export type Token = { content: string; color?: string; italic?: boolean }

export function load(): Promise<Highlighter> {
  return import('./internal/Highlighter.ts').then((module) => module.highlight)
}
