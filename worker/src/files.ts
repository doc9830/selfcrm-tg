// Временные файлы для мини-приложения: отчёт в Excel отдаётся ссылкой.
//
// Зачем это нужно: в WebView клиента Telegram файл со страницы отдать нечем (клиент
// игнорирует blob-ссылки и `<a download>`), а бот живёт в Cloudflare — значит ссылку
// может выдать он же. Тот же Worker, который обслуживает webhook бота, отдаёт и файлы:
//
//   POST /files      — тело: байты файла; заголовки: X-File-Name (percent-encoded) и
//                      Content-Type. Ответ: { id, url, expiresIn }
//   GET  /files/<id> — файл с Content-Disposition: attachment — браузер и клиент
//                      Telegram сохраняют его как обычный документ
//   OPTIONS /files   — предварительный запрос браузера (CORS): мини-приложение живёт
//                      на GitHub Pages, то есть на другом домене
//
// Хранение — Workers KV с истечением срока: постоянных публичных ссылок нет, имя
// случайное (22 символа base64url), размер ограничен, файл живёт час и удаляется
// хранилищем сам. Данные CRM на сервере при этом не живут: KV хранит только
// переданный файл и только до его скачивания — принцип local-first не меняется.
// Переданный файл и его тип. Тип — из ограниченного списка: отчёт это таблица
// (а сюда же можно положить и PDF), а отдавать произвольный `text/html` со своего
// адреса нельзя — браузер выполнит такой ответ как страницу.
const ALLOWED_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
] as const

const DEFAULT_TYPE = 'application/octet-stream'

// Хранилище временных файлов (Workers KV). В `worker/tsconfig.json` нет типов
// Cloudflare (`types: []`), поэтому объявлен ровно тот минимум методов, который нужен:
// положить, прочитать и (для порядка) удалить значение.
export interface ReportFilesStore {
  put(key: string, value: Uint8Array, options?: { expirationTtl?: number }): Promise<void>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  delete(key: string): Promise<void>
}

export interface FilesEnv {
  REPORT_FILES?: ReportFilesStore
}

export const FILES_PATH = '/files'

// Срок жизни файла: час — достаточно, чтобы открыть ссылку и сохранить файл. Дольше
// не нужно: ссылка живёт в чате, а не в CRM.
const FILE_TTL_SECONDS = 60 * 60

// Предел размера: отчёт по личной CRM весит десятки килобайт, поэтому 8 МБ — это
// защита от чужой заливки, а не ограничение для пользователя.
const MAX_FILE_BYTES = 8 * 1024 * 1024

const MAX_NAME_LENGTH = 80

// Идентификатор файла: 16 случайных байт (22 символа base64url). По такому имени
// чужой файл перебором не достать.
const ID_BYTES = 16
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
  'Access-Control-Max-Age': '86400',
}

// Точка входа слоя файлов. null означает «это не адрес файлов» — тогда запрос
// обрабатывают роуты бота (см. worker/src/index.ts).
export async function handleFiles(request: Request, env: FilesEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== FILES_PATH && !url.pathname.startsWith(`${FILES_PATH}/`)) return null

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (url.pathname === FILES_PATH) {
    if (request.method !== 'POST') return message('Method not allowed\n', 405)
    return uploadFile(request, env)
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return message('Method not allowed\n', 405)
  }
  return downloadFile(url.pathname.slice(FILES_PATH.length + 1), request, env)
}

// Приём файла: байты сохраняются во временном хранилище, в ответ приходит ссылка.
async function uploadFile(request: Request, env: FilesEnv): Promise<Response> {
  const store = env.REPORT_FILES
  if (!store) {
    console.error('Не задано хранилище REPORT_FILES: добавьте привязку KV (см. wrangler.toml)')
    return json({ error: 'Файлы временно недоступны' }, 503)
  }

  // Content-Length известен заранее: слишком большой запрос отсекается до чтения тела.
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    return json({ error: 'Файл слишком большой' }, 413)
  }

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) return json({ error: 'Пустой файл' }, 400)
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: 'Файл слишком большой' }, 413)

  const id = randomId()
  const name = decodeFileName(request.headers.get('X-File-Name')) ?? 'SelfCRM_Отчет.xlsx'
  const type = normalizedType(request.headers.get('Content-Type'))

  // Две записи: сам файл и его подпись (имя и тип). Имя не помещается в адрес, а
  // отдавать файл без него нельзя — браузер сохранит его как «download».
  await store.put(id, bytes, { expirationTtl: FILE_TTL_SECONDS })
  await store.put(metaKey(id), new TextEncoder().encode(JSON.stringify({ name, type })), {
    expirationTtl: FILE_TTL_SECONDS,
  })

  const url = `${new URL(request.url).origin}${FILES_PATH}/${id}`
  // В логе только размер и идентификатор: ни имени файла, ни содержимого.
  console.log(`Файл принят: ${id}, ${bytes.byteLength} байт`)
  return json({ id, url, expiresIn: FILE_TTL_SECONDS }, 201)
}

// Отдача файла: имя берётся из подписи, поэтому ссылку можно открывать сколько угодно
// раз, пока не истёк срок хранения.
async function downloadFile(id: string, request: Request, env: FilesEnv): Promise<Response> {
  const store = env.REPORT_FILES
  if (!store) return message('Файлы временно недоступны\n', 503)
  // Идентификатор проверяется по шаблону: чужие ключи хранилища так не перебрать.
  if (!ID_PATTERN.test(id)) return message('Файл не найден\n', 404)

  const bytes = await store.get(id, 'arrayBuffer')
  if (!bytes) return message('Файл не найден или срок хранения истёк\n', 404)

  const meta = await readMeta(store, id)
  const headers = new Headers({
    'Content-Type': meta.type,
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': contentDisposition(meta.name),
    // Файл личный: кэшировать его на прокси и в браузере не нужно.
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    ...CORS_HEADERS,
  })

  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers })
}

interface FileMeta {
  name: string
  type: string
}

async function readMeta(store: ReportFilesStore, id: string): Promise<FileMeta> {
  try {
    const raw = await store.get(metaKey(id), 'arrayBuffer')
    if (!raw) return { name: 'SelfCRM_Отчет.xlsx', type: DEFAULT_TYPE }
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(raw))) as Partial<FileMeta>
    return {
      name: safeFileName(parsed.name) ?? 'SelfCRM_Отчет.xlsx',
      type: normalizedType(parsed.type),
    }
  } catch {
    // Подпись потерялась — файл всё равно отдаём, только с запасным именем.
    return { name: 'SelfCRM_Отчет.xlsx', type: DEFAULT_TYPE }
  }
}

function metaKey(id: string): string {
  return `${id}:name`
}

// 16 случайных байт в base64url: без «+», «/» и «=», чтобы адрес не пришлось
// экранировать.
function randomId(): string {
  const bytes = new Uint8Array(ID_BYTES)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Имя приходит от клиента: убираем пути, служебные символы и ограничиваем длину.
function safeFileName(raw: unknown): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, MAX_NAME_LENGTH).trim()
  return cleaned || null
}

function decodeFileName(header: string | null): string | null {
  if (!header) return null
  try {
    return safeFileName(decodeURIComponent(header))
  } catch {
    // Заголовок пришёл не в percent-encoding — берём как есть.
    return safeFileName(header)
  }
}

function normalizedType(raw: unknown): string {
  const value = String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return (ALLOWED_TYPES as readonly string[]).includes(value) ? value : DEFAULT_TYPE
}

// Имя файла с кириллицей: старый `filename=` не гарантирует UTF-8, поэтому имя
// дублируется в `filename*=UTF-8''…` (RFC 5987) — так его читают и Chrome, и
// встроенный браузер Telegram, и сам клиент при скачивании.
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function message(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
  })
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

