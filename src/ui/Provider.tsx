'use client'

import { NanocodeProvider as Headless, type Skin as Parts } from '../react/Provider.tsx'
import * as Skin from './internal/Skin.ts'

const skin: Parts = { parts: Skin as unknown as NonNullable<Parts['parts']> }

export function NanocodeProvider(props: NanocodeProvider.Props) {
  return <Headless {...props} skin={skin} />
}

export declare namespace NanocodeProvider {
  type Props = Omit<Headless.Props, 'skin'>
}
