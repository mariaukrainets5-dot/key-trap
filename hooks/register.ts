import type { EngineInterface as Dollar, PromptSubmitInput, Register } from 'claude-code'

// Ловушка ключей: ключ, вставленный в сообщение, не уходит в чат.
// Мод спрашивает, сохраняет ключ в .env проекта и заменяет его в тексте именем переменной.

type Kind = { name: string; re: RegExp; check?: (value: string) => string | null }

type Found = { name: string; value: string; start: number; end: number }

// Порядок важен: сначала узкие форматы, потом общие (sk-or- раньше sk-)
const KINDS: Kind[] = [
  { name: 'OPENROUTER_API_KEY', re: /sk-or-v1-[0-9a-f]{64}/g },
  { name: 'ANTHROPIC_API_KEY', re: /sk-ant-[A-Za-z0-9_-]{32,}/g },
  { name: 'STRIPE_SECRET_KEY', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'OPENAI_API_KEY', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'ELEVENLABS_API_KEY', re: /\bsk_[0-9a-f]{48}\b/g },
  { name: 'TELEGRAM_BOT_TOKEN', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { name: 'BREVO_API_KEY', re: /\bxkeysib-[0-9a-f]{64}-[A-Za-z0-9]{16}\b/g },
  { name: 'BREVO_SMTP_KEY', re: /\bxsmtpsib-[0-9a-f]{64}-[A-Za-z0-9]{16}\b/g },
  { name: 'GITHUB_TOKEN', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { name: 'GROQ_API_KEY', re: /\bgsk_[A-Za-z0-9]{48,}\b/g },
  { name: 'AIRTABLE_API_KEY', re: /\bpat[A-Za-z0-9]{14}\.[0-9a-f]{64}\b/g },
  { name: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'AWS_ACCESS_KEY_ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'RAILWAY_TOKEN', re: /\brailway_[A-Za-z0-9_-]{20,}/g },
  { name: 'VERCEL_TOKEN', re: /\bvercel_[A-Za-z0-9_-]{20,}/g },
  { name: 'SUPABASE_SECRET_KEY', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g, check: jwtName },
]

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

// Откуда пришло сообщение: спрашиваем только о том, что ввёл человек
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const SAVE = 'Сохранить в .env'
const AS_IS = 'Отправить как есть'
const STOP = 'Не отправлять'

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || !PERSON.has(e.origin.kind)) return next(e)

    if (PRIVATE_KEY.test(e.text)) {
      return drop($, e, 'В сообщении приватный ключ (BEGIN PRIVATE KEY). Сохраните его в файл сами и напишите мне путь к файлу.')
    }

    const found = findSecrets(e.text)
    if (found.length === 0) return next(e)

    const names = [...new Set(found.map(f => f.name))].join(', ')

    // У слеш-команды движок не даёт переписать текст: только не отправить
    if (e.command) {
      return drop($, e, `В команде ключ (${names}). Отправьте ключ отдельным сообщением, и мод сохранит его в .env.`)
    }

    const root = await $.session.root()
    let answer: string
    try {
      answer = await $.ui.ask(
        `В сообщении ${found.length === 1 ? 'ключ' : `ключи (${found.length})`}: ${names}. ` +
          `Сохранить в ${root}/.env и отправить сообщение без значения? ` +
          'В «Other» можно вписать другую папку проекта.',
        { header: 'Ключ', options: [SAVE, AS_IS, STOP] },
      )
    } catch {
      return drop($, e, 'Сообщение с ключом не отправлено: вопрос закрыт без ответа.')
    }

    if (answer === AS_IS) return next(e)
    if (answer === STOP) return drop($, e, 'Сообщение с ключом не отправлено.')

    const envPath = answer === SAVE ? `${root}/.env` : await envPathFrom($, answer.trim(), root)
    const report = await saveToEnv($, envPath, found)
    const shown = envPath.startsWith(`${root}/`) ? envPath.slice(root.length + 1) : envPath

    let text = ''
    let at = 0
    for (const f of found) {
      text += e.text.slice(at, f.start) + `[ключ ${f.name} сохранён в ${shown}, значение скрыто]`
      at = f.end
    }
    text += e.text.slice(at)

    const note =
      `Пользователь вставил ${found.length === 1 ? 'ключ' : 'ключи'} ${names}. ` +
      `Мод «Ловушка ключей» сохранил их в ${envPath}; значения от тебя скрыты. ` +
      'Обращайся к ним по имени переменной, не проси показать значение и не выводи его. ' +
      'Если ключ нужен в другом месте (Railway, Vercel, Apps Script), скажи пользователю, какую переменную туда вставить.'

    $.ui.toast(`Ключ в чат не ушёл. ${report}`, { timeoutMs: 8000 })

    return next({ ...e, text, context: [...(e.context ?? []), note] })
  }).catch(async ($, e, next) =>
    next.called ? next(e) : drop($, e, 'Ловушка ключей не смогла проверить сообщение, поэтому не отправила его. Попробуйте ещё раз.'),
  )
}

// Возвращает текст в поле ввода и не пускает сообщение дальше
async function drop($: Dollar, e: PromptSubmitInput, reason: string) {
  const back = await $.prompt.fill({ text: e.text }).catch(() => ({ isFilled: false }))
  return { drop: back.isFilled ? `${reason} Текст вернулся в поле ввода.` : reason }
}

export function findSecrets(text: string): Found[] {
  const found: Found[] = []
  const taken = (s: number, t: number) => found.some(f => s < f.end && t > f.start)

  for (const kind of KINDS) {
    for (const m of text.matchAll(kind.re)) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (taken(start, end)) continue
      const name = kind.check ? kind.check(m[0]) : kind.name
      if (!name) continue
      found.push({ name: nameFromLine(text, start) ?? name, value: m[0], start, end })
    }
  }

  found.sort((a, b) => a.start - b.start)

  // Разные ключи с одним именем: OPENAI_API_KEY, OPENAI_API_KEY_2
  const seen = new Map<string, string[]>()
  for (const f of found) {
    const values = seen.get(f.name) ?? []
    if (!values.includes(f.value)) values.push(f.value)
    seen.set(f.name, values)
    const n = values.indexOf(f.value)
    if (n > 0) f.name = `${f.name}_${n + 1}`
  }

  return found
}

// «OPENROUTER_API_KEY=sk-...» — имя берём из текста
function nameFromLine(text: string, start: number): string | null {
  const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, start)
  const m = /(?:^|[\s,;])(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*[:=]\s*["']?$/.exec(line)
  return m?.[1] ?? null
}

// Публичный anon-ключ Supabase не секрет: его не трогаем
function jwtName(token: string): string | null {
  const payload = decodeBase64Url(token.split('.')[1] ?? '')
  let claims: { role?: string; iss?: string } = {}
  try {
    claims = JSON.parse(payload)
  } catch {
    return 'JWT_TOKEN'
  }
  if (claims.role === 'anon') return null
  if (claims.role === 'service_role') return 'SUPABASE_SERVICE_ROLE_KEY'
  if (claims.iss === 'supabase') return 'SUPABASE_KEY'
  return 'JWT_TOKEN'
}

function decodeBase64Url(s: string): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) {
    const v = abc.indexOf(ch)
    if (v < 0) return ''
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  try {
    return decodeURIComponent(bytes.map(b => `%${b.toString(16).padStart(2, '0')}`).join(''))
  } catch {
    return ''
  }
}

async function envPathFrom($: Dollar, typed: string, root: string): Promise<string> {
  let p = typed.replace(/^["']|["']$/g, '').replace(/\/+$/, '')
  if (p.startsWith('~')) p = `${await $.env.get('HOME')}${p.slice(1)}`
  if (!p.startsWith('/')) p = `${root}/${p}`
  return /(^|\/)\.env[^/]*$/.test(p) ? p : `${p}/.env`
}

async function saveToEnv($: Dollar, envPath: string, found: Found[]): Promise<string> {
  const old: string = (await $.fs.exists(envPath)) ? await $.fs.read(envPath) : ''
  const lines = old === '' ? [] : old.replace(/\n$/, '').split('\n')
  const done: string[] = []
  const written = new Set<string>()

  for (const f of found) {
    if (written.has(f.name)) continue
    written.add(f.name)
    const at = lines.findIndex(l => new RegExp(`^\\s*(?:export\\s+)?${f.name}\\s*=`).test(l))
    const line = `${f.name}=${f.value}`
    if (at < 0) {
      lines.push(line)
      done.push(`${f.name} добавлен`)
    } else if ((lines[at] ?? '').replace(/^\s*(?:export\s+)?[A-Z0-9_]+\s*=\s*["']?|["']?\s*$/g, '') === f.value) {
      done.push(`${f.name} уже был`)
    } else {
      lines[at] = line
      done.push(`${f.name} обновлён`)
    }
  }

  await $.fs.write(envPath, `${lines.join('\n')}\n`)

  const ignored = await ignoreEnv($, envPath)
  return `${envPath}: ${done.join(', ')}.${ignored ? ' .env добавлен в .gitignore.' : ''}`
}

// В папке с git .env должен быть в .gitignore, иначе ключ уедет на GitHub
async function ignoreEnv($: Dollar, envPath: string): Promise<boolean> {
  const dir = envPath.slice(0, envPath.lastIndexOf('/'))
  const file = envPath.slice(dir.length + 1)
  if (!(await $.fs.exists(`${dir}/.git`))) return false
  const path = `${dir}/.gitignore`
  const text: string = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const covered = text.split('\n').some(l => {
    const rule = l.trim().replace(/^\//, '')
    return rule === file || rule === '.env' || rule === '.env*' || rule === '*.env' || rule === '.env.*' && file !== '.env'
  })
  if (covered) return false
  await $.fs.write(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${file}\n`)
  return true
}
