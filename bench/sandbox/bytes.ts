import * as Assert from 'node:assert/strict'
import { Sandbox } from '@vercel/sandbox'
import type * as Contracts from '../../src/Contracts.ts'
import * as Container from '../../src/sandbox/Container.ts'
import * as VercelSandbox from '../../src/sandbox/VercelSandbox.ts'

type Fixture = {
  dispose(): Promise<void>
  files: Map<string, Uint8Array>
  workspace: Contracts.WorkspaceHost
  writes(): number
}

const encoder = new TextEncoder()
const path = '/workspace/sample.txt'

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}

function container(): Fixture {
  const files = new Map<string, Uint8Array>()
  let writes = 0
  const handle: Container.Handle = {
    running: true,
    start() {},
    async setInactivityTimeout() {},
    async destroy() {},
    async exec(argv, options) {
      const target = argv.at(-1)!
      const reading = argv[2]?.includes('exec cat --')
      if (options?.stdin) {
        files.set(target, new Uint8Array(await new Response(options.stdin).arrayBuffer()))
        writes++
      }
      return {
        exitCode: Promise.resolve(reading && !files.has(target) ? 44 : 0),
        kill() {},
        stderr: stream(new Uint8Array()),
        stdout: stream(
          reading
            ? (files.get(target) ?? new Uint8Array())
            : argv[0] === 'timeout'
              ? Uint8Array.of(255)
              : new Uint8Array(),
        ),
      }
    },
  }
  const workspace = Container.create(handle, { enableInternet: false, setup: '' })
  return { dispose: () => workspace.stop(), files, workspace, writes: () => writes }
}

function vercel(): Fixture {
  const files = new Map<string, Uint8Array>()
  let writes = 0
  const sandbox = {
    fs: { async mkdir() {} },
    async readFileToBuffer(options: { path: string }) {
      const bytes = files.get(options.path)
      return bytes === undefined ? null : Buffer.from(bytes)
    },
    async runCommand() {
      return {
        async kill() {},
        async *logs() {
          yield { data: Uint8Array.of(255), stream: 'stdout' }
        },
        async wait() {
          return { exitCode: 0 }
        },
      }
    },
    async stop() {},
    async writeFiles(entries: readonly { content: string; path: string }[]) {
      for (const entry of entries) {
        files.set(entry.path, encoder.encode(entry.content))
        writes++
      }
    },
  }
  const original = Sandbox.getOrCreate
  Sandbox.getOrCreate = async () => sandbox as unknown as Sandbox
  const workspace = VercelSandbox.create({ name: 'offline-byte-regression' })
  return {
    async dispose() {
      try {
        await workspace.stop()
      } finally {
        Sandbox.getOrCreate = original
      }
    },
    files,
    workspace,
    writes: () => writes,
  }
}

const cases = ['', '\ufeff', 'old', '\ufeffold']
for (const bom of ['', '\ufeff'])
  for (const ending of ['\n', '\r\n'])
    for (let count = 0; count <= 3; count++)
      cases.push(bom + 'head' + ending + 'old é🦀' + ending + 'tail' + ending.repeat(count))

const invalid = [
  Uint8Array.of(255),
  Uint8Array.of(195),
  Uint8Array.of(237, 160, 128),
  Uint8Array.of(239, 187, 191, 111, 255, 10),
  Uint8Array.of(240, 159, 146),
]

let failed = 0
for (const create of [container, vercel]) {
  const fixture = create()
  let passed = 0
  const check = async (options: { name: string; run(): Promise<void> }) => {
    try {
      await options.run()
      passed++
    } catch (error) {
      failed++
      console.error(create.name, options.name, error)
    }
  }
  try {
    for (const [index, original] of cases.entries())
      await check({
        name: 'exact bytes ' + index,
        async run() {
          fixture.files.set(path, encoder.encode(original))
          const text = await fixture.workspace.read(path)
          Assert.equal(text, original)
          Assert.notEqual(text, null)
          await fixture.workspace.write(path, text!.replace('old', 'new'))
          Assert.deepEqual(fixture.files.get(path), encoder.encode(original.replace('old', 'new')))
        },
      })

    for (const [index, bytes] of invalid.entries())
      await check({
        name: 'invalid UTF-8 ' + index,
        async run() {
          fixture.files.set(path, bytes)
          const writes = fixture.writes()
          await Assert.rejects(async () => {
            const text = await fixture.workspace.read(path)
            Assert.notEqual(text, null)
            await fixture.workspace.write(path, text!.replace('old', 'new'))
          }, TypeError)
          Assert.equal(fixture.writes(), writes)
          Assert.deepEqual(fixture.files.get(path), bytes)
        },
      })

    await check({
      name: 'missing file',
      async run() {
        fixture.files.delete(path)
        Assert.equal(await fixture.workspace.read(path), null)
      },
    })

    await check({
      name: 'shell output stays lossy',
      async run() {
        const output = await fixture.workspace.run(
          { command: 'offline-mock-output', cwd: '/workspace', timeout_ms: null },
          new AbortController().signal,
        )
        Assert.equal(output.exit_code, 0)
        Assert.equal(output.stdout, '\ufffd')
      },
    })
  } finally {
    await fixture.dispose()
  }
  console.log(
    JSON.stringify({ adapter: create.name, passed, total: cases.length + invalid.length + 2 }),
  )
}

if (failed) throw new Error(`${failed} adapter byte checks failed`)
