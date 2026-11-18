export type Options = {
  unavailable?: string
  maxBytes?: number
  module?: false | WebAssembly.Module | (() => Promise<WebAssembly.Module>)
  // python.data, the memory image python.wasm starts from (gzip or not), or a function that loads it once
  // per isolate; by default Node reads nanocode-ts/python.data beside python.wasm.
  data?: Data
  cpuMs?: number
  stepsPerMs?: number
  // Where scripts that import polars run. python.wasm leaves polars out (it would grow from 29 MB to
  // 64 MB), so a host that wants it supplies a second interpreter: a script whose source imports one of
  // sci.modules (polars by default) goes there, and so does one the main interpreter stops with
  // ModuleNotFoundError for one of them. Without sci such a script fails with an error naming polars.
  sci?: Sci
}

export type Data =
  | Uint8Array
  | ArrayBuffer
  | Promise<Uint8Array | ArrayBuffer>
  | (() => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer | undefined> | undefined)

type Loads = WebAssembly.Module | (() => Promise<WebAssembly.Module>)

// The polars python.wasm in this process, on the same files as python3 (Node and Vercel: PythonSci.local),
// or a runner elsewhere that is sent the files the script can read and returns the files it wrote
// (Cloudflare: a python-sci Worker behind a service binding, PythonSci.remote).
export type Sci = (
  | { module: Loads; data: Data; run?: undefined }
  | { run(request: SciRequest, signal: AbortSignal): Promise<SciResult>; module?: undefined }
) & {
  mode?: 'all' | 'imports'
  modules?: readonly string[]
  // The most bytes of files a remote run is sent, maxMemoryBytes by default: the files named on the
  // command line or quoted as absolute paths in the code, then the working directory, then site-packages.
  sendBytes?: number
}

export type SciRequest = {
  argv: readonly string[]
  cwd: string
  env: Record<string, string>
  files: [path: string, bytes: Uint8Array][]
  memory: number
  stdin: Uint8Array
  timeMs: number
}

export type SciResult = {
  kind: string
  status: number
  stdout: string
  stderr: string
  // The files the run created or changed, and the paths it deleted, which python3 applies to the workspace.
  files: [path: string, bytes: Uint8Array][]
  deleted?: string[]
}
