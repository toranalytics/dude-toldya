import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { projectKey } from '../src/scope.mjs'
import { placeBlock, renderBlock, selectForExport, START, END } from '../src/export.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const base = mkdtempSync(join(tmpdir(), 'otw-export-'))
after(() => rmSync(base, { recursive: true, force: true }))
let n = 0

function box(rows) {
  const dir = join(base, String(n++)), home = join(dir, 'data'), ws = join(dir, 'ws'), other = join(dir, 'other')
  for (const d of [dir, home, ws, other]) mkdirSync(d)
  const rec = (quote, extra = {}, cwd = ws, at = 1) => JSON.stringify({ quote, about: 'a request', at, project: projectKey(cwd), origin: 'interactive-user', ...extra })
  const lines = rows({ rec, ws, other })
  writeFileSync(join(home, 'corrections.jsonl'), lines.join('\n') + '\n')
  const env = { ...process.env, OTW_HOME: home, HOME: join(dir, 'h'), PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter) }
  const run = (args, cwd = ws) => { const r = spawnSync(process.execPath, [join(root, 'bin/duto.mjs'), 'export', ...args], { env, cwd, encoding: 'utf8', timeout: 8000 }); assert.equal(r.error, undefined); return r }
  return { dir, home, ws, other, run }
}

test('preview shows the block and writes nothing', () => {
  const b = box(({ rec }) => [rec('use pnpm, not npm', {}, undefined, 1), rec('commit messages are conventional commits', {}, undefined, 2)])
  const r = b.run([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /use pnpm, not npm/)
  assert.match(r.stdout, /nothing was written/)
  assert.equal(existsSync(join(b.ws, 'AGENTS.md')), false)
  assert.deepEqual(readdirSync(b.ws), [])
})

test('--yes writes oldest first, unchanged, only this directory, recallable records, identical quotes once', () => {
  const b = box(({ rec, other }) => [
    rec('second correction', {}, undefined, 2),
    rec('first correction', {}, undefined, 1),
    rec('first correction', {}, undefined, 3),
    rec('from another directory', {}, other),
    rec('legacy record', { origin: 'unknown' }),
    'not json',
  ])
  const r = b.run(['--yes'])
  assert.equal(r.status, 0)
  const text = readFileSync(join(b.ws, 'AGENTS.md'), 'utf8')
  assert.ok(text.startsWith(START))
  assert.ok(text.trimEnd().endsWith(END))
  const bullets = text.split('\n').filter(l => l.startsWith('- '))
  assert.deepEqual(bullets, ['- first correction', '- second correction'])
  assert.equal(text.includes('another directory'), false)
  assert.equal(text.includes('legacy record'), false)
})

test('re-running replaces only the block and keeps the rest of the file', () => {
  const b = box(({ rec }) => [rec('keep it short')])
  const file = join(b.ws, 'AGENTS.md')
  writeFileSync(file, '# Notes\n\nSomething I wrote.\n')
  assert.equal(b.run(['--yes']).status, 0)
  const once = readFileSync(file, 'utf8')
  assert.ok(once.startsWith('# Notes\n\nSomething I wrote.\n'))
  writeFileSync(join(b.home, 'corrections.jsonl'), JSON.stringify({ quote: 'a newer correction', about: 'x', at: 5, project: projectKey(b.ws), origin: 'interactive-user' }) + '\n')
  assert.equal(b.run(['--yes']).status, 0)
  const twice = readFileSync(file, 'utf8')
  assert.ok(twice.startsWith('# Notes\n\nSomething I wrote.\n'))
  assert.ok(twice.includes('a newer correction'))
  assert.equal(twice.includes('keep it short'), false)
  assert.equal(twice.split(START).length, 2)
})

test('--host claude writes CLAUDE.md; --file must be a plain name', () => {
  const b = box(({ rec }) => [rec('no emoji')])
  assert.equal(b.run(['--host', 'claude', '--yes']).status, 0)
  assert.ok(existsSync(join(b.ws, 'CLAUDE.md')))
  assert.equal(b.run(['--file', '../x.md', '--yes']).status, 2)
  assert.equal(b.run(['--file', 'sub/x.md', '--yes']).status, 2)
  assert.equal(b.run(['--host', 'other']).status, 2)
  assert.equal(b.run(['--bogus']).status, 2)
})

test('refuses a symlinked target and damaged markers, touching nothing', () => {
  const b = box(({ rec }) => [rec('x correction')])
  const real = join(b.dir, 'real.md')
  writeFileSync(real, 'keep')
  symlinkSync(real, join(b.ws, 'AGENTS.md'))
  const r = b.run(['--yes'])
  assert.equal(r.status, 1)
  assert.equal(readFileSync(real, 'utf8'), 'keep')
  rmSync(join(b.ws, 'AGENTS.md'))
  writeFileSync(join(b.ws, 'AGENTS.md'), `intro\n${START}\nhalf`)
  const r2 = b.run(['--yes'])
  assert.equal(r2.status, 1)
  assert.equal(readFileSync(join(b.ws, 'AGENTS.md'), 'utf8'), `intro\n${START}\nhalf`)
})

test('nothing to export is a clear, successful no-op', () => {
  const b = box(({ rec, other }) => [rec('elsewhere', {}, other)])
  const r = b.run(['--yes'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /nothing to export/)
  assert.equal(existsSync(join(b.ws, 'AGENTS.md')), false)
})

test('unit: long quotes are cut visibly, newlines collapse, placeBlock handles trailing newlines', () => {
  const project = projectKey(base)
  const long = 'a'.repeat(700)
  const { quotes, truncated } = selectForExport([{ quote: `line one\nline two`, at: 1, project, origin: 'interactive-user' }, { quote: long, at: 2, project, origin: 'interactive-user' }], project)
  assert.equal(quotes[0], 'line one line two')
  assert.ok(quotes[1].endsWith('…') && quotes[1].length === 601)
  assert.equal(truncated, 1)
  const block = renderBlock(['q'])
  assert.equal(placeBlock('', block), block + '\n')
  assert.equal(placeBlock('a', block), 'a\n\n' + block + '\n')
  assert.equal(placeBlock('a\n', block), 'a\n\n' + block + '\n')
  assert.equal(placeBlock(`x${START}y${END}z`, block), `x${block}z`)
  assert.equal(placeBlock(`${END}${START}`, block), null)
})
