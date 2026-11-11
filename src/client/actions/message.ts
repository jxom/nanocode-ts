import type * as Client from '../Client.ts'
import * as Instance from '../internal/Instance.ts'
import type * as Message from '../Message.ts'
import type * as Model from '../Model.ts'
import type * as Transcript from '../Transcript.ts'
import type * as Transport from '../Transport.ts'

export function list(client: Client.Client): readonly Message.Message[] {
  return Instance.get(client).messages()
}

export function note(client: Client.Client, options: note.Options): void {
  Instance.get(client).config.note(options.kind, options.text)
}

export declare namespace note {
  type Options = {
    kind: Transcript.EntryKind
    text: string
  }
}

export async function send(client: Client.Client, options: send.Options): Promise<void> {
  const instance = Instance.get(client)
  await instance.ready()
  return instance.config.send(options.text, options.attachments)
}

export declare namespace send {
  type Options = {
    attachments?: readonly Transport.Attachment[] | undefined
    text: string
  }

  type ErrorType = Model.ListError
}

export function stop(client: Client.Client): Promise<void> {
  return Instance.get(client).config.cancel()
}
