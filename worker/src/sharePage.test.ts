// Проверки страницы «Поделиться»: она открывается в браузере телефона и отдаёт файл
// системному меню. Здесь проверяется разметка и защита, а не меню: меню открывает браузер.
import { describe, expect, it, vi } from 'vitest'
import { FILES_PATH, handleFiles, type ReportFilesStore } from './files'
import { SHARE_PAGE_PATH, handleSharePage } from './sharePage'

// Заглушка Workers KV: та же, что в проверках файлов, — страница читает из неё имя и тип.
function stubStore(): ReportFilesStore & { keys: string[] } {
  const values = new Map<string, Uint8Array>()
  const keys: string[] = []
  return {
    keys,
    async put(key, value) {
      keys.push(key)
      values.set(key, value)
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
    },
  }
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function uploadRequest(name: string, type = XLSX) {
  const body = new TextEncoder().encode('xlsx-bytes')
  return new Request('https://selfcrm-bot.example.workers.dev/files', {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) },
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  })
}

// Файл в хранилище: страница читает его имя и тип по идентификатору.
async function storeFile(store: ReportFilesStore, name = 'SelfCRM_Отчет.xlsx'): Promise<string> {
  const response = (await handleFiles(uploadRequest(name), { REPORT_FILES: store })) as Response
  const body = (await response.json()) as { id: string }
  return body.id
}

function pageRequest(id: string, query = '', method = 'GET') {
  return new Request(
    `https://selfcrm-bot.example.workers.dev${SHARE_PAGE_PATH}/${id}${query}`,
    { method },
  )
}

describe('адрес страницы опознаётся отдельно от файлов и бота', () => {
  it('чужой путь не трогаем', async () => {
    const request = new Request('https://selfcrm-bot.example.workers.dev/telegram/webhook')
    expect(await handleSharePage(request, { REPORT_FILES: stubStore() })).toBeNull()
  })

  it('файлы свою страницу не перехватывают', async () => {
    const request = new Request('https://selfcrm-bot.example.workers.dev/files', { method: 'GET' })
    expect(await handleSharePage(request, { REPORT_FILES: stubStore() })).toBeNull()
  })

  it('не GET отвечает, что метод не поддерживается', async () => {
    const response = (await handleSharePage(pageRequest('A'.repeat(22), '', 'POST'), {
      REPORT_FILES: stubStore(),
    })) as Response
    expect(response.status).toBe(405)
  })

  it('без хранилища объясняет, что настройка не завершена', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = (await handleSharePage(pageRequest('A'.repeat(22)), {})) as Response
    expect(response.status).toBe(503)
    expect(error.mock.calls.flat().join(' ')).toContain('REPORT_FILES')
    error.mockRestore()
  })
})

describe('страница с файлом', () => {
  it('отдаёт имя файла, кнопку «Поделиться» и ссылку на файл', async () => {
    const store = stubStore()
    const id = await storeFile(store)

    const response = (await handleSharePage(
      pageRequest(id, '?text=%D0%9E%D1%82%D1%87%D1%91%D1%82%20SelfCRM'),
      { REPORT_FILES: store },
    )) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    const body = await response.text()
    // Файл берётся со своего адреса: браузер отдаёт системному меню файл своего источника.
    expect(body).toContain(`${FILES_PATH}/${id}`)
    expect(body).toContain('SelfCRM_Отчет.xlsx')
    expect(body).toContain('Отчёт SelfCRM')
    // Меню открывает страница, и только по нажатию.
    expect(body).toContain('navigator')
    expect(body).toContain('share(')
    expect(body).toContain('addEventListener')
    // Запасной путь для браузера без системного меню.
    expect(body).toContain('download="SelfCRM_Отчет.xlsx"')
    expect(body).toContain('Скачать файл')
  })

  it('файл, который системное меню не берёт, страница не обещает отдать меню', async () => {
    // Chromium делится только PDF, картинками, звуком, видео и текстом: таблицу `.xlsx` он
    // меню не отдаёт. Страница проверяет это по факту (пробным файлом) и предлагает скачивание,
    // а на отказ меню отвечает скачиванием — «ничего не произошло» быть не должно.
    const store = stubStore()
    const id = await storeFile(store)

    const response = (await handleSharePage(pageRequest(id), { REPORT_FILES: store })) as Response
    const body = await response.text()

    expect(body).toContain('canShare')
    expect(body).toContain('save.className')
    expect(body).toContain('Файл скачан в «Загрузки»')
    expect(body).toContain('save.click()')
  })

  it('подпись и имя файла не разрывают разметку и скрипт', async () => {
    const store = stubStore()
    const id = await storeFile(store)

    const response = (await handleSharePage(
      pageRequest(id, `?text=${encodeURIComponent('</script><img src=x onerror=alert(1)>')}`),
      { REPORT_FILES: store },
    )) as Response
    const body = await response.text()

    // Ни в скрипте, ни в тексте страницы нет тега из подписи.
    expect(body).not.toContain('</script><img')
    expect(body).not.toContain('<img src=x')
    // В скрипте опасные символы экранированы, в разметке — заменены сущностями.
    expect(body).toContain('\\u003c/script')
    expect(body).toContain('&lt;/script&gt;')
  })

  it('пустая подпись не оставляет пустую строку на странице', async () => {
    const store = stubStore()
    const id = await storeFile(store)

    const response = (await handleSharePage(pageRequest(id), { REPORT_FILES: store })) as Response
    const body = await response.text()

    expect(body).not.toContain('class="caption"')
    expect(body).toContain('Файл SelfCRM готов к отправке')
  })

  it('страница закрыта от чужого кадра, кэша и индексации', async () => {
    const store = stubStore()
    const id = await storeFile(store)

    const response = (await handleSharePage(pageRequest(id), { REPORT_FILES: store })) as Response

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
    // Скрипт и стили страницы разрешены одноразовым nonce: чужой скрипт не выполнится.
    const policy = response.headers.get('Content-Security-Policy') ?? ''
    const issued = policy.match(/script-src 'nonce-([^']+)'/)?.[1]
    expect(issued).toBeTruthy()
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("connect-src 'self'")
    const body = await response.text()
    expect(body).toContain(`<script nonce="${issued}">`)
    expect(body).not.toContain('unsafe-inline')
  })
})

describe('устаревшая ссылка', () => {
  it('объясняет срок хранения вместо пустой страницы', async () => {
    const response = (await handleSharePage(pageRequest('B'.repeat(22)), {
      REPORT_FILES: stubStore(),
    })) as Response

    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).toContain('Ссылка больше не работает')
    expect(body).toContain('час')
  })

  it('чужой идентификатор в хранилище не ищет', async () => {
    // Идентификатор не по шаблону: страница проверяет его до обращения к хранилищу, поэтому
    // чужие ключи (и чужие пути) перебором не достать.
    const store = stubStore()
    const lookups: string[] = []
    const watched: ReportFilesStore = {
      put: store.put,
      delete: store.delete,
      get: async (key) => {
        lookups.push(key)
        return store.get(key, 'arrayBuffer')
      },
    }

    const response = (await handleSharePage(pageRequest('x'.repeat(30)), {
      REPORT_FILES: watched,
    })) as Response

    expect(response.status).toBe(404)
    expect(lookups).toEqual([])
    expect(store.keys).toEqual([])
  })

  it('адрес без идентификатора — та же устаревшая ссылка', async () => {
    const response = (await handleSharePage(
      new Request(`https://selfcrm-bot.example.workers.dev${SHARE_PAGE_PATH}`),
      { REPORT_FILES: stubStore() },
    )) as Response

    expect(response.status).toBe(404)
  })
})
