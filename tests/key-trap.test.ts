import { expect, test } from 'claude-code/testing'

// Ключи собраны из частей, чтобы в файле не лежал ни один ключ целиком
const OPENROUTER = 'sk-or-v1-' + 'a1'.repeat(32)
const BOT = '1234567890:AA' + 'Bc1_d'.repeat(6) + 'xyz'
const JWT_PART = (o: object) => btoaUrl(JSON.stringify(o))
const SERVICE = `eyJhbGciOiJIUzI1NiJ9.${JWT_PART({ iss: 'supabase', role: 'service_role' })}.${'s'.repeat(43)}`
const ANON = `eyJhbGciOiJIUzI1NiJ9.${JWT_PART({ iss: 'supabase', role: 'anon' })}.${'s'.repeat(43)}`

function btoaUrl(s: string) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type World = { files: Map<string, string>; sent: { text: string; context?: readonly string[] }[]; asked: string[]; filled: string[] }

// Под модом — подставной движок: файлы в памяти, ответ на вопрос задаёт тест
function engine(on: any, answer: string, root = '/proj', files: Record<string, string> = {}): World {
  const w: World = { files: new Map(Object.entries(files)), sent: [], asked: [], filled: [] }
  on('session.root', () => ({ value: root }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.exists', (_: any, e: any) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_: any, e: any) => ({ value: w.files.get(e.path) }))
  on('fs.write', (_: any, e: any) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.fill', (_: any, e: any) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_: any, e: any) => {
    const q = e.questions[0]
    w.asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  on('prompt.submit', (_: any, e: any) => {
    w.sent.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  return w
}

const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('обычное сообщение уходит без вопросов', async ($, on) => {
  const w = engine(on, 'Сохранить в .env')
  await submit($, 'пушь, я не рендерю')
  expect(w.asked.length).toBe(0)
  expect(w.sent[0]?.text).toBe('пушь, я не рендерю')
})

test('ключ OpenRouter уходит в .env, в чат — только имя', async ($, on) => {
  const w = engine(on, 'Сохранить в .env', '/proj', { '/proj/.git': '' })
  await submit($, `поменяй ключ ${OPENROUTER} пожалуйста`)

  expect(w.asked.length).toBe(1)
  expect(w.files.get('/proj/.env')).toBe(`OPENROUTER_API_KEY=${OPENROUTER}\n`)
  expect(w.files.get('/proj/.gitignore')).toBe('.env\n')
  const sent = w.sent[0]
  expect(sent?.text).toBe('поменяй ключ [ключ OPENROUTER_API_KEY сохранён в .env, значение скрыто] пожалуйста')
  expect(JSON.stringify(sent)).not.toContain(OPENROUTER)
  expect(sent?.context?.[0]).toContain('OPENROUTER_API_KEY')
})

test('старое значение в .env заменяется, остальные строки на месте', async ($, on) => {
  const w = engine(on, 'Сохранить в .env', '/proj', { '/proj/.env': 'A=1\nOPENROUTER_API_KEY=old\nB=2\n' })
  await submit($, OPENROUTER)
  expect(w.files.get('/proj/.env')).toBe(`A=1\nOPENROUTER_API_KEY=${OPENROUTER}\nB=2\n`)
})

test('имя переменной берётся из «ИМЯ=значение» и несколько ключей разбираются', async ($, on) => {
  const w = engine(on, 'Сохранить в .env')
  await submit($, `MY_BOT_TOKEN=${BOT}\nи ещё ${SERVICE}`)
  const env = w.files.get('/proj/.env') ?? ''
  expect(env).toContain(`MY_BOT_TOKEN=${BOT}`)
  expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`)
  expect(w.sent[0]?.text).not.toContain(BOT)
  expect(w.sent[0]?.text).not.toContain(SERVICE)
})

test('публичный anon-ключ Supabase не трогаем', async ($, on) => {
  const w = engine(on, 'Сохранить в .env')
  await submit($, `anon: ${ANON}`)
  expect(w.asked.length).toBe(0)
  expect(w.sent[0]?.text).toBe(`anon: ${ANON}`)
})

test('в «Other» можно вписать папку проекта', async ($, on) => {
  const w = engine(on, '~/projects/my-bot')
  await submit($, OPENROUTER)
  expect(w.files.get('/Users/me/projects/my-bot/.env')).toBe(`OPENROUTER_API_KEY=${OPENROUTER}\n`)
  expect(w.sent[0]?.text).toContain('/Users/me/projects/my-bot/.env')
})

test('«Не отправлять» — сообщение не уходит, текст возвращается в поле', async ($, on) => {
  const w = engine(on, 'Не отправлять')
  const r = await submit($, `ключ ${OPENROUTER}`)
  expect(w.sent.length).toBe(0)
  expect(r.drop).toContain('не отправлено')
  expect(w.filled[0]).toBe(`ключ ${OPENROUTER}`)
  expect(w.files.size).toBe(0)
})

test('«Отправить как есть» — уходит без изменений', async ($, on) => {
  const w = engine(on, 'Отправить как есть')
  await submit($, `ключ ${OPENROUTER}`)
  expect(w.sent[0]?.text).toBe(`ключ ${OPENROUTER}`)
  expect(w.files.size).toBe(0)
})
