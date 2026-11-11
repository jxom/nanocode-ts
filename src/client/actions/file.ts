import type * as Client from '../Client.ts'
import * as Format from '../internal/Format.ts'
import * as Instance from '../internal/Instance.ts'
import type * as Transport from '../Transport.ts'

export function get(client: Client.Client): get.ReturnType {
  const found = Instance.get(client).config.files
  if (!found) return { status: 'unavailable' }
  return { maxBytes: found.maxBytes, maxFiles: found.maxFiles, status: 'available' }
}

export declare namespace get {
  type ReturnType =
    | { maxBytes: number | undefined; maxFiles: number | undefined; status: 'available' }
    | { status: 'unavailable' }
}

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
  const found = files(client)
  if (found.maxBytes !== undefined && options.file.size > found.maxBytes)
    return Promise.reject(new TooLargeError({ maxBytes: found.maxBytes, name: options.name }))
  return found.upload(options.file, options.name, options.signal)
}

export declare namespace upload {
  type Options = {
    file: Blob
    name: string
    signal?: AbortSignal | undefined
  }

  type ErrorType = TooLargeError | UnavailableError
}

function files(client: Client.Client): Transport.Files {
  const found = Instance.get(client).config.files
  if (!found) throw new UnavailableError()
  return found
}

export class LimitError extends Error {
  override readonly name = 'Actions.file.LimitError'

  constructor(options: { maxFiles: number }) {
    super(`A message takes at most ${options.maxFiles} files.`)
  }
}

export class TooLargeError extends Error {
  override readonly name = 'Actions.file.TooLargeError'

  constructor(options: { maxBytes: number; name: string }) {
    super(`${options.name} is larger than ${Format.bytes(options.maxBytes)}.`)
  }
}

export class UnavailableError extends Error {
  override readonly name = 'Actions.file.UnavailableError'

  constructor() {
    super('The transport has no workspace files.')
  }
}
