// Проверки моста отчёта: загрузка в временное хранилище и скачивание клиентом.
//
// Сеть и окно подменяются заглушками: проверяем именно то, что мини-приложение
// отправляет на Worker и о чём просит клиент Telegram.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  reportFileBridge,
  registerReportFileBridge,
  type ReportShareResult,
} from '../reports/delivery'
import {
  registerTelegramReportFiles,
  reportFileBridge as bridge,
  reportFilesUrl,
  uploadReportFile,
} from './files'
import type { TelegramEventPayload, TelegramWebApp } from './webapp'

afterEach(() => {
  registerReportFileBridge(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const FILE_NAME = 'SelfCRM_Отчет_Все_время.xlsx'

// Идентификатор и адрес файла, как их отдаёт Worker: по идентификатору мини-приложение
// просит подготовить сообщение «Поделиться».
const FILE_ID = 'abc123'
const FILE_URL = `https://worker.test/files/${FILE_ID}`

// Заглушка окна мини-приложения: клиент Telegram называет себя `initData` и платформой,
// а методы скачивания и открытия ссылок добавляются тестом. `window.open` возвращает
// null — так ведёт себя браузер, заблокировавший всплывающее окно.
function stubTelegramWindow(webApp: Partial<TelegramWebApp> = {}) {
  vi.stubGlobal('window', {
    Telegram: { WebApp: { initData: 'query_id=1', platform: 'android', ...webApp } },
    open: () => null,
  })
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return handler(String(input), init)
  })
  return requests
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Ответ Worker'а на загрузку файла: ссылка и идентификатор.
function uploadedResponse(): Response {
  return jsonResponse({ id: FILE_ID, url: FILE_URL }, 201)
}

// Ответ Worker'а на подготовку сообщения «Поделиться»: идентификатор для клиента и ссылка на
// копию файла со свежим сроком.
const FRESH_FILE_URL = 'https://worker.test/files/fresh123'

function preparedResponse(): Response {
  return jsonResponse({ preparedMessageId: 'prepared-1', url: FRESH_FILE_URL }, 201)
}

// Ответ по адресу: загрузка файла и подготовка сообщения различаются хвостом адреса.
function stubWorker(options: { prepareStatus?: number } = {}) {
  return stubFetch((url, init) => {
    if (url.endsWith('/share')) {
      if (options.prepareStatus && options.prepareStatus >= 400) {
        return jsonResponse({ error: 'Telegram не принял сообщение' }, options.prepareStatus)
      }
      expect(String(init?.method)).toBe('POST')
      return preparedResponse()
    }
    return uploadedResponse()
  })
}

// «Поделиться» есть не у любого моста: у моста Telegram — всегда, чем тест и пользуется.
async function shareReport(): Promise<ReportShareResult> {
  if (!bridge.share) throw new Error('у моста нет пути «Поделиться»')
  return await bridge.share({ blob: new Blob(['xlsx']), fileName: FILE_NAME, message: 'Отчёт SelfCRM' })
}

describe('адрес выгрузки', () => {
  it('ведёт на слой файлов Worker', () => {
    expect(reportFilesUrl()).toMatch(/^https:\/\/.+\/files$/)
  })
})

describe('загрузка файла во временное хранилище', () => {
  it('отправляет файл и имя, получает ссылку и идентификатор', async () => {
    const requests = stubFetch(() => uploadedResponse())

    const uploaded = await uploadReportFile(new Blob(['xlsx']), FILE_NAME)

    expect(uploaded).toEqual({ id: FILE_ID, url: FILE_URL })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(reportFilesUrl())
    expect(requests[0].init?.method).toBe('POST')
    // Имя уходит заголовком: в теле — только сам файл.
    const headers = requests[0].init?.headers as Record<string, string>
    expect(headers['X-File-Name']).toBe(encodeURIComponent(FILE_NAME))
    expect(headers['Content-Type']).toContain('spreadsheetml')
  })

  it('слишком большой файл не отправляется', async () => {
    const requests = stubFetch(() => jsonResponse({ url: 'не важно' }))
    const big = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)])

    await expect(uploadReportFile(big, FILE_NAME)).rejects.toThrow('слишком большой')
    expect(requests).toHaveLength(0)
  })

  it('нет сети — понятный текст вместо технической ошибки', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(uploadReportFile(new Blob(['x']), FILE_NAME)).rejects.toThrow('Нет связи')
  })

  it('Worker без хранилища объясняет, что это настройка сервера', async () => {
    stubFetch(() => jsonResponse({ error: 'Файлы временно недоступны' }, 503))
    await expect(uploadReportFile(new Blob(['x']), FILE_NAME)).rejects.toThrow('не настроена')
  })

  it('отказ сервера — понятный текст', async () => {
    stubFetch(() => jsonResponse({ error: 'Файл слишком большой' }, 413))
    await expect(uploadReportFile(new Blob(['x']), FILE_NAME)).rejects.toThrow('не принял файл')
  })

  it('ответ без ссылки или без идентификатора не считается успехом', async () => {
    stubFetch(() => jsonResponse({ id: FILE_ID }, 201))
    await expect(uploadReportFile(new Blob(['x']), FILE_NAME)).rejects.toThrow('не вернул ссылку')

    // Без идентификатора «Поделиться» не подготовить, поэтому такой ответ тоже отказ.
    stubFetch(() => jsonResponse({ url: FILE_URL }, 201))
    await expect(uploadReportFile(new Blob(['x']), FILE_NAME)).rejects.toThrow('не вернул ссылку')
  })
})


describe('мост: файл → ссылка → клиент Telegram', () => {
  it('клиент скачивает файл сам (downloadFile)', async () => {
    const calls: Array<{ url: string; file_name: string }> = []
    stubTelegramWindow({
      downloadFile: (params) => {
        calls.push(params)
      },
    })
    stubFetch(() => uploadedResponse())

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт',
    })

    expect(result).toEqual({ kind: 'opened', url: FILE_URL })
    expect(calls).toEqual([{ url: FILE_URL, file_name: FILE_NAME }])
  })

  it('старый клиент открывает ссылку браузером', async () => {
    const opened: string[] = []
    stubTelegramWindow({
      openLink: (url) => {
        opened.push(url)
      },
    })
    stubFetch(() => uploadedResponse())

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт',
    })

    expect(result.kind).toBe('opened')
    expect(opened).toEqual([FILE_URL])
  })

  it('если ссылку открыть нечем, она ложится в буфер обмена', async () => {
    const copied: string[] = []
    stubTelegramWindow({})
    stubFetch(() => uploadedResponse())
    vi.stubGlobal('navigator', {
      clipboard: { writeText: async (text: string) => void copied.push(text) },
    })

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт SelfCRM',
    })

    expect(result.kind).toBe('copied')
    expect(copied[0]).toContain(FILE_URL)
    expect(copied[0]).toContain('Отчёт SelfCRM')
  })

  it('буфер обмена недоступен — честный отказ', async () => {
    stubTelegramWindow({})
    stubFetch(() => uploadedResponse())
    vi.stubGlobal('navigator', {})

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт',
    })

    expect(result.kind).toBe('failed')
  })
})

describe('поделиться: файл → сообщение бота → выбор чата', () => {
  // Заглушка клиента, умеющего отправлять сообщения бота. Обработчик события отказа
  // («shareMessageFailed») тест забирает себе, чтобы позвонить в него в нужный момент, —
  // так же, как это делает клиент Telegram.
  function stubSharingClient(
    answer: (
      msgId: string,
      api: { sent: (ok: boolean) => void; fail: (error?: string) => void },
    ) => void,
  ): string[] {
    const shared: string[] = []
    const handlers = new Map<string, (payload?: TelegramEventPayload) => void>()
    stubTelegramWindow({
      onEvent: (event, handler) => handlers.set(event, handler),
      offEvent: (event) => handlers.delete(event),
      shareMessage: (msgId, callback) => {
        shared.push(msgId)
        answer(msgId, {
          sent: (ok) => callback?.(ok),
          fail: (error) => handlers.get('shareMessageFailed')?.(error ? { error } : undefined),
        })
      },
    })
    return shared
  }

  it('файл уходит документом: Worker готовит сообщение, клиент открывает меню', async () => {
    const shared = stubSharingClient((_msgId, api) => api.sent(true))
    const requests = stubWorker()

    expect(await shareReport()).toEqual({ kind: 'sent' })
    expect(shared).toEqual(['prepared-1'])

    // Подготовка идёт по тому же слою файлов: идентификатор файла и `/share`. В теле —
    // подпись сессии мини-приложения (по ней Worker узнаёт пользователя) и подпись сообщения.
    const prepare = requests.find((request) => request.url.endsWith('/share'))
    expect(prepare?.url).toBe(`${reportFilesUrl()}/${FILE_ID}/share`)
    const body = JSON.parse(String(prepare?.init?.body)) as { initData: string; caption: string }
    expect(body.initData).toBe('query_id=1')
    expect(body.caption).toBe('Отчёт SelfCRM')
  })

  it('пользователь закрыл меню — это отмена, а не сбой', async () => {
    stubSharingClient((_msgId, api) => {
      api.fail('USER_DECLINED')
      api.sent(false)
    })
    stubWorker()

    expect(await shareReport()).toEqual({ kind: 'cancelled' })
  })

  it('сообщение устарело — исход отличается от сбоя', async () => {
    stubSharingClient((_msgId, api) => api.fail('MESSAGE_EXPIRED'))
    stubWorker()

    expect(await shareReport()).toEqual({ kind: 'expired' })
  })

  it('клиент без shareMessage: уходит ссылка на свежую копию файла', async () => {
    const opened: string[] = []
    stubTelegramWindow({ openTelegramLink: (url) => void opened.push(url) })
    stubWorker()

    expect(await shareReport()).toEqual({ kind: 'link' })
    expect(opened).toHaveLength(1)
    expect(opened[0].startsWith('https://t.me/share/url?')).toBe(true)
    // Ссылка ведёт на свежую копию: у исходной срок мог уже наполовину выйти.
    expect(decodeURIComponent(opened[0])).toContain(FRESH_FILE_URL)
  })

  it('Telegram не принял сообщение: уходит ссылка на исходный файл', async () => {
    const opened: string[] = []
    stubTelegramWindow({
      openTelegramLink: (url) => void opened.push(url),
      shareMessage: (_msgId, callback) => callback?.(true),
    })
    stubWorker({ prepareStatus: 502 })

    expect(await shareReport()).toEqual({ kind: 'link' })
    expect(decodeURIComponent(opened[0])).toContain(FILE_URL)
  })

  it('отправка не удалась и ссылку открыть нечем — честный отказ', async () => {
    // Клиент отказал с незнакомой причиной, а открывать ссылки он не умеет: окно выбора чата
    // и всплывающее окно браузера в заглушке закрыты — сообщить об этом нужно текстом.
    stubSharingClient((_msgId, api) => api.fail('UNKNOWN_ERROR'))
    stubWorker()

    expect(await shareReport()).toEqual({ kind: 'failed' })
  })

  it('клиент не умеет ни отправлять сообщение, ни открывать ссылку', async () => {
    stubTelegramWindow({})
    stubWorker({ prepareStatus: 502 })

    expect(await shareReport()).toEqual({ kind: 'unavailable' })
  })

  it('callback без события: исход всё равно сообщается, а не молчит', async () => {
    vi.useFakeTimers()
    stubSharingClient((_msgId, api) => api.sent(false))
    stubWorker()

    const promise = shareReport()
    // Пауза в разборе исхода — это ожидание события с причиной: без него закрытое меню
    // выглядело бы как сбой.
    await vi.advanceTimersByTimeAsync(500)

    expect(await promise).toEqual({ kind: 'failed' })
  })
})

describe('регистрация моста', () => {
  it('в клиенте Telegram мост доступен общей выгрузке', () => {
    stubTelegramWindow({})
    registerTelegramReportFiles()
    expect(reportFileBridge()).toBe(bridge)
  })

  it('в обычном браузере мост не ставится: файл скачается как обычно', () => {
    vi.stubGlobal('window', {})
    registerTelegramReportFiles()
    expect(reportFileBridge()).toBeNull()
  })
})
