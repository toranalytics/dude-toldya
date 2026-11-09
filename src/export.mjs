// `duto export`: write this working directory's stored corrections, word for word, into AGENTS.md or CLAUDE.md.
// Foreground only; it never runs from a hook. Without --yes it only prints what it would write.
// It touches one marked block in one file inside the working directory and nothing else.
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve, relative, sep } from 'node:path'
import { projectKey } from './scope.mjs'
import { recallable } from './similar.mjs'

export const START = '<!-- dude-toldya:start (managed by `duto export`; edits inside this block are overwritten) -->'
export const END = '<!-- dude-toldya:end -->'
const MAX_QUOTE = 600
const WARN_AT = 300
const FILES = { codex: 'AGENTS.md', claude: 'CLAUDE.md' }

export const USAGE = `duto export [--host codex|claude] [--cwd DIR] [--file NAME] [--yes]
  Writes the corrections stored for that working directory (default: the current one), unchanged, as bullets in one
  marked block of AGENTS.md (--host codex, the default) or CLAUDE.md (--host claude) in that directory. --file picks
  another file name inside the directory. Re-running replaces only that block. Without --yes it only shows the block
  and the file it would change. A rules file is read in full on every request, so it does not depend on recall picking
  the right quote. Nothing is sent to a model. The file will contain your own past messages: check that it is not
  committed or shared if they are private.`

const kind = path => { try { const s = lstatSync(path); return s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other' } catch { return 'none' } }
const oneLine = s => String(s).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()

// Corrections that recall itself would be allowed to quote for this directory, oldest first, identical quotes once.
export function selectForExport(list, project) {
  const seen = new Set(), out = []
  let truncated = 0
  for (const c of list.filter(c => recallable(c) && c.project === project).sort((a, b) => a.at - b.at)) {
    let q = oneLine(c.quote)
    if (!q || seen.has(q)) continue
    seen.add(q)
    if (q.length > MAX_QUOTE) { q = `${q.slice(0, MAX_QUOTE)}…`; truncated++ }
    out.push(q)
  }
  return { quotes: out, truncated }
}

export function renderBlock(quotes) {
  return [START, '## Corrections the user made earlier in this project (exported by Dude Toldya)', '', ...quotes.map(q => `- ${q}`), END].join('\n')
}

// Replace the marked block, or append it. Returns null when the markers are damaged.
export function placeBlock(text, block) {
  const a = text.indexOf('<!-- dude-toldya:start'), b = text.indexOf(END)
  const hasStart = a >= 0, hasEnd = b >= 0
  if (hasStart !== hasEnd || (hasStart && (b < a || text.indexOf('<!-- dude-toldya:start', a + 1) >= 0 || text.indexOf(END, b + 1) >= 0))) return null
  if (hasStart) return text.slice(0, a) + block + text.slice(b + END.length)
  return text + (text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n') + block + '\n'
}

export function runExport({ list, args, cwd }) {
  const has = n => args.includes(`--${n}`)
  const arg = n => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null }
  const known = new Set(['--host', '--cwd', '--file', '--yes'])
  const values = new Set(['--host', '--cwd', '--file'])
  const stray = args.filter((a, i) => a.startsWith('--') ? !known.has(a) : !values.has(args[i - 1]))
  if (stray.length) return { code: 2, lines: [USAGE] }
  for (const n of ['host', 'cwd', 'file']) if (has(n) && !arg(n)) return { code: 2, lines: [USAGE] }
  const host = arg('host') ?? 'codex'
  if (!FILES[host]) return { code: 2, lines: [`unknown host ${host}; use codex or claude`] }
  const dir = arg('cwd') ?? cwd
  const key = projectKey(dir)
  if (!key || !isAbsolute(dir)) return { code: 2, lines: [`not an absolute directory: ${dir}`] }
  const name = arg('file') ?? FILES[host]
  const target = resolve(dir, name)
  const rel = relative(resolve(dir), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length > 1) return { code: 2, lines: ['--file must be a plain file name inside the working directory'] }
  if (kind(dir) !== 'dir') return { code: 1, lines: [`not a directory: ${dir}`] }
  const { quotes, truncated } = selectForExport(list, key)
  if (!quotes.length) return { code: 0, lines: [`no stored corrections for ${dir}: nothing to export. Corrections are saved as you correct the agent in that directory.`] }
  const k = kind(target)
  if (k === 'link' || k === 'dir' || k === 'other') return { code: 1, lines: [`${target} is not a regular file; nothing was touched`] }
  const block = renderBlock(quotes)
  const before = k === 'file' ? readFileSync(target, 'utf8') : ''
  const next = placeBlock(before, block)
  if (next === null) return { code: 1, lines: [`${target} has an unmatched or duplicated Dude Toldya marker; fix or remove it by hand. Nothing was touched`] }
  const lines = [`working directory ${dir}`, `file ${target} (${k === 'file' ? (before.includes('<!-- dude-toldya:start') ? 'block will be replaced' : 'block will be appended') : 'will be created'})`, `corrections: ${quotes.length}${truncated ? ` (${truncated} longer than ${MAX_QUOTE} characters were cut and end with …)` : ''}`]
  if (quotes.length > WARN_AT) lines.push(`warning: ${quotes.length} corrections make a long file that is read on every request`)
  if (!has('yes')) {
    lines.push('', block, '', 'nothing was written. Add --yes to write it.', 'The file will contain your own past messages. Check that it is not committed or shared if they are private.')
    return { code: 0, lines }
  }
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, next, { flag: 'wx', mode: 0o644 })
    if (k === 'file') { try { chmodSync(temp, lstatSync(target).mode & 0o7777) } catch {} }
    renameSync(temp, target)
  } finally { try { unlinkSync(temp) } catch {} }
  lines.push('written. Re-run `duto export --yes` to refresh the block; text outside it is left alone.', 'The file contains your own past messages. Check that it is not committed or shared if they are private.')
  return { code: 0, lines }
}
