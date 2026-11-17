export type Options = {
  maxBytes?: number
  module?: false | WebAssembly.Module | (() => Promise<WebAssembly.Module>)
  // python.data, the memory image python.wasm starts from (gzip or not), or a function that loads it once
  // per isolate; by default Node reads nanocode-ts/python.data beside python.wasm.
  data?:
    | Uint8Array
    | ArrayBuffer
    | Promise<Uint8Array | ArrayBuffer>
    | (() => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer | undefined> | undefined)
  cpuMs?: number
  stepsPerMs?: number
}
