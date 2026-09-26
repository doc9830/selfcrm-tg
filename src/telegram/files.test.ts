// Проверки моста отчёта: загрузка в временное хранилище и скачивание клиентом.
//
// Сеть и окно подменяются заглушками: проверяем именно то, что мини-приложение
// отправляет на Worker и о чём просит клиент Telegram.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportFileBridge, registerReportFileBridge } from '../reports/delivery'
import {
  registerTelegramReportFiles,
  reportFileBridge as bridge,
  reportFilesUrl,
  uploadReportFile,
} from './files'
import type { TelegramWebApp } from './webapp'

afterEach(() => {
  registerReportFileBridge(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const FILE_NAME = 'SelfCRM_Отчет_Все_время.xlsx'

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

describe('адрес выгрузки', () => {
  it('ведёт на слой файлов Worker', () => {
    expect(reportFilesUrl()).toMatch(/^https:\/\/.+\/files$/)
  })
})

describe('загрузка файла во временное хранилище', () => {
  it('отправляет файл и имя, получает ссылку', async () => {
    const requests = stubFetch(() => jsonResponse({ url: 'https://worker.test/files/abc' }))

    const url = await uploadReportFile(new Blob(['xlsx']), FILE_NAME)

    expect(url).toBe('https://worker.test/files/abc')
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

  it('ответ без ссылки не считается успехом', async () => {
    stubFetch(() => jsonResponse({ id: 'abc' }, 201))
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
    stubFetch(() => jsonResponse({ url: 'https://worker.test/files/abc' }))

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт',
    })

    expect(result).toEqual({ kind: 'opened', url: 'https://worker.test/files/abc' })
    expect(calls).toEqual([{ url: 'https://worker.test/files/abc', file_name: FILE_NAME }])
  })

  it('старый клиент открывает ссылку браузером', async () => {
    const opened: string[] = []
    stubTelegramWindow({
      openLink: (url) => {
        opened.push(url)
      },
    })
    stubFetch(() => jsonResponse({ url: 'https://worker.test/files/abc' }))

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт',
    })

    expect(result.kind).toBe('opened')
    expect(opened).toEqual(['https://worker.test/files/abc'])
  })

  it('если ссылку открыть нечем, она ложится в буфер обмена', async () => {
    const copied: string[] = []
    stubTelegramWindow({})
    stubFetch(() => jsonResponse({ url: 'https://worker.test/files/abc' }))
    vi.stubGlobal('navigator', {
      clipboard: { writeText: async (text: string) => void copied.push(text) },
    })

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт SelfCRM',
    })

    expect(result.kind).toBe('copied')
    expect(copied[0]).toContain('https://worker.test/files/abc')
    expect(copied[0]).toContain('Отчёт SelfCRM')
  })

  it('буфер обмена недоступен — честный отказ', async () => {
    stubTelegramWindow({})
    stubFetch(() => jsonResponse({ url: 'https://worker.test/files/abc' }))
    vi.stubGlobal('navigator', {})

    const result = await bridge.send({
      blob: new Blob(['xlsx']),
      fileName: FILE_NAME,
      message: 'Отчёт',
    })

    expect(result.kind).toBe('failed')
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
