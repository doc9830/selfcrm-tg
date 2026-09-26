// Проверки «Поделиться»: подготовка сообщения с файлом по подписанному запросу.
//
// Bot API и хранилище подменяются заглушками: проверяется то, что Worker отправляет в
// Telegram (метод и его поля), что файл копируется со свежим сроком и как отвечает маршрут
// на отказы. Подпись initData собирается помощником из worker/src/webappAuthFixture.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILES_PATH,
  FILE_TTL_SECONDS,
  handleFiles,
  REPORT_PDF_TYPE,
  REPORT_XLSX_TYPE,
  type ReportFilesStore,
} from './files'
import { handleReportShare } from './share'
import type { Deps, Env } from './telegram'
import { freshInitData, TEST_BOT_TOKEN, TEST_USER_ID } from './webappAuthFixture'

const REPORT_NAME = 'SelfCRM_Отчет_2026-09-01_2026-09-26.xlsx'
const REPORT_CAPTION = 'Отчёт SelfCRM: за 2026-09-01 — 2026-09-26'
const ORIGIN = 'https://selfcrm-bot.example.workers.dev'

// Заглушка Workers KV: помнит значения и срок, с которым их записали. По сроку видно, что
// копия файла получает новый час, а «живучесть» ключей проверяет настоящая KV.
function stubStore() {
  const values = new Map<string, Uint8Array>()
  const ttl = new Map<string, number | undefined>()
  const store: ReportFilesStore = {
    async put(key, value, options) {
      values.set(key, value)
      ttl.set(key, options?.expirationTtl)
    },
    async get(key) {
      const value = values.get(key)
      if (!value) return null
      const copy = new ArrayBuffer(value.byteLength)
      new Uint8Array(copy).set(value)
      return copy
    },
    async delete(key) {
      values.delete(key)
      ttl.delete(key)
    },
  }
  return { store, values, ttl }
}

// Тело запроса — ArrayBuffer: так его принимает и Worker, и тип Request.
function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
}

function envWith(store: ReportFilesStore | undefined, overrides: Partial<Env> = {}): Env {
  return {
    BOT_TOKEN: TEST_BOT_TOKEN,
    WEBHOOK_SECRET: 'test-secret',
    ...(store ? { REPORT_FILES: store } : {}),
    ...overrides,
  }
}

// Заглушка Bot API: пишет вызванные методы с телом, отвечает как Telegram.
function stubTelegram(
  log: Array<{ method: string; body: Record<string, any> }>,
  options: { fail?: boolean; result?: unknown } = {},
): Deps {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split('/').pop() ?? ''
    log.push({ method, body: JSON.parse(String(init?.body ?? '{}')) })
    if (options.fail) {
      return new Response(
        JSON.stringify({ ok: false, description: `Bad Request: токен ${TEST_BOT_TOKEN}` }),
        { status: 400 },
      )
    }
    const result = options.result ?? { id: 'prepared-1', expiration_date: 1758800000 }
    return new Response(JSON.stringify({ ok: true, result }))
  }
  return { fetch: fetchImpl as unknown as typeof fetch }
}

// Загрузка файла тем же путём, что и мини-приложение: так «Поделиться» проверяется на живом
// файле из хранилища, а не на подставленном.
async function uploadReport(store: ReportFilesStore, type: string = REPORT_XLSX_TYPE): Promise<string> {
  const response = await handleFiles(
    new Request(`${ORIGIN}${FILES_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(REPORT_NAME) },
      body: bytes('xlsx-содержимое'),
    }),
    { REPORT_FILES: store },
  )
  expect(response?.status).toBe(201)
  const payload = (await response!.json()) as { id: string }
  return payload.id
}

function shareRequest(
  id: string,
  body: unknown,
  options: { method?: string; headers?: Record<string, string> } = {},
) {
  const method = options.method ?? 'POST'
  return new Request(`${ORIGIN}${FILES_PATH}/${id}/share`, {
    method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('адрес отправки', () => {
  const store = stubStore()

  it('не перехватывает чужие адреса', async () => {
    const env = envWith(store.store)
    const deps = stubTelegram([])

    const paths = [
      `${FILES_PATH}`,
      `${FILES_PATH}/abcdefghijklmnopqrstuv`,
      `${FILES_PATH}/abcdefghijklmnopqrstuv/share/ещё`,
      '/telegram/webhook',
      '/',
    ]

    for (const path of paths) {
      const response = await handleReportShare(
        new Request(`${ORIGIN}${path}`, { method: 'POST', body: '{}' }),
        env,
        deps,
      )
      expect(response).toBeNull()
    }
  })

  it('предзапрос браузера оставляет слою файлов: заголовки CORS там же', async () => {
    const id = await uploadReport(store.store)
    const options = new Request(`${ORIGIN}${FILES_PATH}/${id}/share`, { method: 'OPTIONS' })

    expect(await handleReportShare(options, envWith(store.store), stubTelegram([]))).toBeNull()

    // Тот же предзапрос доходит до слоя файлов и получает разрешение на POST: иначе браузер
    // не отправит запрос вовсе, и кнопка «Поделиться» молча ничего не сделает.
    const files = await handleFiles(options, { REPORT_FILES: store.store })
    expect(files?.status).toBe(204)
    expect(files?.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('на другие методы отвечает 405', async () => {
    const id = await uploadReport(store.store)
    const response = await handleReportShare(
      shareRequest(id, null, { method: 'GET' }),
      envWith(store.store),
      stubTelegram([]),
    )

    expect(response?.status).toBe(405)
  })
})

describe('отказы', () => {
  it('без хранилища файлов и без токена бота отвечает 503', async () => {
    const store = stubStore()
    const id = await uploadReport(store.store)

    const withoutStore = await handleReportShare(
      shareRequest(id, { initData: 'x' }),
      envWith(undefined),
      stubTelegram([]),
    )
    expect(withoutStore?.status).toBe(503)

    const withoutToken = await handleReportShare(
      shareRequest(id, { initData: 'x' }),
      envWith(store.store, { BOT_TOKEN: '' }),
      stubTelegram([]),
    )
    expect(withoutToken?.status).toBe(503)
  })

  it('не читаемое тело отвергает без вызовов Bot API', async () => {
    const store = stubStore()
    const id = await uploadReport(store.store)
    const calls: Array<{ method: string; body: Record<string, any> }> = []

    const response = await handleReportShare(
      new Request(`${ORIGIN}${FILES_PATH}/${id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'не-json',
      }),
      envWith(store.store),
      stubTelegram(calls),
    )

    expect(response?.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('подпись не подтверждена: 403 и ни одного вызова Bot API', async () => {
    const store = stubStore()
    const id = await uploadReport(store.store)
    const calls: Array<{ method: string; body: Record<string, any> }> = []
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const initData of [undefined, '', 'мусор', 'auth_date=1&user=%7B%22id%22%3A1%7D']) {
      const response = await handleReportShare(
        shareRequest(id, { initData }),
        envWith(store.store),
        stubTelegram(calls),
      )
      expect(response?.status).toBe(403)
      expect(await response!.json()).toEqual({ error: 'Подпись не подтверждена' })
    }

    expect(calls).toEqual([])
    // В лог попадает только факт отказа: ни подписи, ни данных пользователя.
    expect(log.mock.calls.flat().join(' ')).toContain('подпись initData не подтверждена')
  })

  it('файла нет: 404', async () => {
    const store = stubStore()
    const response = await handleReportShare(
      shareRequest('abcdefghijklmnopqrstuv', { initData: await freshInitData() }),
      envWith(store.store),
      stubTelegram([]),
    )

    expect(response?.status).toBe(404)
  })

  it('Bot API отказал: 502 без токена в ответе', async () => {
    const store = stubStore()
    const id = await uploadReport(store.store)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handleReportShare(
      shareRequest(id, { initData: await freshInitData() }),
      envWith(store.store),
      stubTelegram([], { fail: true }),
    )

    expect(response?.status).toBe(502)
    const text = await response!.text()
    expect(text).not.toContain(TEST_BOT_TOKEN)
    expect(log.mock.calls.flat().join(' ')).not.toContain(TEST_BOT_TOKEN)
  })

  it('Bot API не вернул сообщение: 502', async () => {
    const files = stubStore()
    const id = await uploadReport(files.store)

    const response = await handleReportShare(
      shareRequest(id, { initData: await freshInitData() }),
      envWith(files.store),
      stubTelegram([], { result: {} }),
    )

    expect(response?.status).toBe(502)
  })
})

describe('подготовка сообщения', () => {
  const store = stubStore()

  it('копирует файл и просит Bot API собрать сообщение', async () => {
    const originalId = await uploadReport(store.store)
    const calls: Array<{ method: string; body: Record<string, any> }> = []

    const response = await handleReportShare(
      shareRequest(originalId, { initData: await freshInitData(), caption: REPORT_CAPTION }),
      envWith(store.store),
      stubTelegram(calls),
    )

    expect(response?.status).toBe(201)
    const payload = (await response!.json()) as {
      preparedMessageId: string
      url: string
      expiresIn: number
    }
    expect(payload.preparedMessageId).toBe('prepared-1')
    expect(payload.expiresIn).toBe(FILE_TTL_SECONDS)

    // Адрес в ответе — тот же, что уходит в сообщение: идентификатор копии плюс имя файла.
    const segments = payload.url.split('/')
    const freshId = segments[segments.length - 2] ?? ''
    expect(freshId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // Имя стоит последним куском адреса: по нему Telegram называет документ в чате.
    expect(decodeURIComponent(segments[segments.length - 1] ?? '')).toBe(REPORT_NAME)
    // Ссылка в сообщении ведёт на копию, а не на исходный файл: у копии срок отсчитывается
    // заново, поэтому отправку можно делать и через час после выгрузки.
    expect(freshId).not.toBe(originalId)
    expect(payload.url).toBe(`${ORIGIN}${FILES_PATH}/${freshId}/${encodeURIComponent(REPORT_NAME)}`)

    expect(calls).toEqual([
      {
        method: 'savePreparedInlineMessage',
        body: {
          user_id: TEST_USER_ID,
          result: {
            type: 'document',
            id: freshId,
            title: 'SelfCRM_Отчет_2026-09-01_2026-09-26',
            document_url: `${ORIGIN}${FILES_PATH}/${freshId}/${encodeURIComponent(REPORT_NAME)}`,
            // Отчёт в Excel отдаётся как zip — единственный тип, которым Telegram разрешает
            // отдать не-PDF документ (проверено вызовом Bot API: тип таблицы он отклоняет).
            mime_type: 'application/zip',
            caption: REPORT_CAPTION,
          },
          allow_user_chats: true,
          allow_group_chats: true,
          allow_bot_chats: false,
          allow_channel_chats: false,
        },
      },
    ])

    // Копия получила тот же час и подпись имени, а исходная запись осталась на месте.
    expect(store.ttl.get(freshId)).toBe(FILE_TTL_SECONDS)
    expect(store.ttl.get(`${freshId}:name`)).toBe(FILE_TTL_SECONDS)
    expect(store.values.get(freshId)).toBeDefined()
    expect(store.values.get(originalId)).toBeDefined()
  })

  it('запасной тип файла заменяется типом отчёта, а PDF остаётся PDF', async () => {
    const files = stubStore()
    // Файл пришёл с чужим Content-Type: в хранилище остался запасной тип, а в сообщении нужен
    // один из двух разрешённых Telegram — отчёт отдаём как zip (это его контейнер).
    const id = await uploadReport(files.store, 'text/html')
    const calls: Array<{ method: string; body: Record<string, any> }> = []

    const response = await handleReportShare(
      shareRequest(id, { initData: await freshInitData() }),
      envWith(files.store),
      stubTelegram(calls),
    )

    expect(response?.status).toBe(201)
    expect(calls[0].body.result.mime_type).toBe('application/zip')

    // PDF в сообщении остаётся собой: это второй тип, который Telegram принимает.
    const pdfStore = stubStore()
    const pdfId = await uploadReport(pdfStore.store, REPORT_PDF_TYPE)
    const pdfCalls: Array<{ method: string; body: Record<string, any> }> = []

    const pdfResponse = await handleReportShare(
      shareRequest(pdfId, { initData: await freshInitData() }),
      envWith(pdfStore.store),
      stubTelegram(pdfCalls),
    )

    expect(pdfResponse?.status).toBe(201)
    expect(pdfCalls[0].body.result.mime_type).toBe(REPORT_PDF_TYPE)
  })

  it('подпись сообщения обрезается и теряет управляющие символы', async () => {
    const files = stubStore()
    const id = await uploadReport(files.store)
    const calls: Array<{ method: string; body: Record<string, any> }> = []

    const response = await handleReportShare(
      shareRequest(id, {
        initData: await freshInitData(),
        caption: `Отчёт\n\nза\tпериод ${'я'.repeat(500)}`,
      }),
      envWith(files.store),
      stubTelegram(calls),
    )

    expect(response?.status).toBe(201)
    const caption = calls[0].body.result.caption as string
    expect(caption.startsWith('Отчёт за период')).toBe(true)
    expect(caption.length).toBe(400)
    expect(caption).not.toContain('\n')
  })

  it('без подписи сообщение уходит одним файлом', async () => {
    const files = stubStore()
    const id = await uploadReport(files.store)
    const calls: Array<{ method: string; body: Record<string, any> }> = []

    const response = await handleReportShare(
      shareRequest(id, { initData: await freshInitData(), caption: '   \n  ' }),
      envWith(files.store),
      stubTelegram(calls),
    )

    expect(response?.status).toBe(201)
    expect('caption' in calls[0].body.result).toBe(false)
  })
})
