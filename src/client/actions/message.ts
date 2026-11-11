import * as Instance from '../internal/Instance.ts'
import type * as Message from '../Message.ts'
import type * as Transcript from '../Transcript.ts'
import type * as Transport from '../Transport.ts'

export function list(client: object): readonly Message.Message[] {
  return Instance.get(client).messages()
}

export function note(client: object, options: note.Options): void {
  Instance.get(client).config.note(options.kind, options.text)
}

export declare namespace note {
  type Options = {
    kind: Transcript.EntryKind
    text: string
  }
}

export function send(client: object, options: send.Options): Promise<void> {
  return Instance.get(client).config.send(options.text, options.attachments)
}

export declare namespace send {
  type Options = {
    attachments?: readonly Transport.Attachment[] | undefined
    text: string
  }
}

export function stop(client: object): Promise<void> {
  return Instance.get(client).config.cancel()
}
