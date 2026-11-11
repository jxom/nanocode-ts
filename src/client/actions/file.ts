import type * as Client from '../Client.ts'
import * as Instance from '../internal/Instance.ts'
import type * as Transport from '../Transport.ts'

export function read(client: Client.Client, options: read.Options): Promise<Blob> {
  return files(client).read(options.path, options.signal)
}

export declare namespace read {
  type Options = {
    path: string
    signal?: AbortSignal | undefined
  }

  type ErrorType = UnavailableError
}

export function upload(
  client: Client.Client,
  options: upload.Options,
): Promise<Transport.Attachment> {
  return files(client).upload(options.file, options.name, options.signal)
}

export declare namespace upload {
  type Options = {
    file: Blob
    name: string
    signal?: AbortSignal | undefined
  }

  type ErrorType = UnavailableError
}

function files(client: Client.Client): Transport.Files {
  const found = Instance.get(client).config.files
  if (!found) throw new UnavailableError()
  return found
}

export class UnavailableError extends Error {
  override readonly name = 'Actions.file.UnavailableError'

  constructor() {
    super('The transport has no workspace files.')
  }
}
