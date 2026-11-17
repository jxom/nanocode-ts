// @ts-expect-error resolved by esbuild to the dist under test
import * as Bash from 'nanocode-dist'
import * as Measure from './measure.ts'
// @ts-expect-error workerd module
import python from './python.wasm'
// @ts-expect-error workerd module
import psh from './psh.wasm'
// @ts-expect-error workerd module
import data from './python.data'

type Wire = Omit<Measure.Job, 'files'> & { files: [string, string][] }

const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/run') return new Response('up')
    const wire = (await request.json()) as Wire
    const job: Measure.Job = {
      ...wire,
      files: wire.files.map(([path, text]) => [path, decode(text)] as const),
    }
    const result = await Measure.measure(
      {
        runtime: 'workerd',
        python: python as WebAssembly.Module,
        psh: psh as WebAssembly.Module,
        data: data as ArrayBuffer,
        compileMs: 0,
        create: async (options) => {
          const fs = Bash.MemoryFileSystem.create()
          return {
            bash: await Bash.Bash.create({ ...(options as object), fs }),
            write: (path: string, bytes: Uint8Array) => fs.write(path, bytes),
          }
        },
        heap: () => 0,
        rss: () => 0,
      },
      job,
    )
    return Response.json(result)
  },
}
