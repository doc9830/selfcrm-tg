// Проверки временных файлов: приём, отдача, срок хранения и защита от чужих имён.
//
// Сеть и хранилище подменяются заглушками: Worker в тесте работает точно так же, как
// в Cloudflare, — KV здесь обычная Map с ограничением по сроку.
import { describe, expect, it, vi } from 'vitest'
import { FILES_PATH, handleFiles, type ReportFilesStore } from './files'

// Заглушка Workers KV: хранит значения до истечения срока, как настоящая.
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
      // Копия, а не срез буфера: тип возврата — именно ArrayBuffer.
      const copy = new ArrayBuffer(value.byteLength)
      new Uint8Array(copy).set(value)
      return copy
    },
    async delete(key) {
      values.delete(key)
    },
  }
}

const env = () => ({ REPORT_FILES: stubStore() })

// Тело запроса — ArrayBuffer: так его принимает и Worker, и тип Request.
function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
}

function uploadRequest(body: ArrayBuffer | string, headers: Record<string, string> = {}) {
  return new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...headers },
    body,
  })
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

describe('адрес файлов опознаётся отдельно от роутов бота', () => {
  it('чужой путь не трогаем', async () => {
    const request = new Request('https://selfcrm-bot.example.workers.dev/telegram/webhook')
    expect(await handleFiles(request, env())).toBeNull()
  })

  it('предварительный запрос браузера получает разрешение CORS', async () => {
    const request = new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}`, {
      method: 'OPTIONS',
    })
    const response = (await handleFiles(request, env())) as Response
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-File-Name')
  })
})

describe('POST /files — приём файла', () => {
  it('принимает файл и возвращает ссылку со случайным именем', async () => {
    const store = stubStore()
    const response = (await handleFiles(
      uploadRequest(bytes('xlsx-bytes'), { 'X-File-Name': encodeURIComponent('SelfCRM_Отчет.xlsx') }),
      { REPORT_FILES: store },
    )) as Response

    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; url: string; expiresIn: number }
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.url).toBe(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/${body.id}`)
    expect(body.expiresIn).toBe(3600)
    // Файл и его подпись лежат под разными ключами: имя не помещается в адрес.
    expect(store.keys).toEqual([body.id, `${body.id}:name`])
  })

  it('без хранилища объясняет, что настройка не завершена', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = (await handleFiles(uploadRequest(bytes('abc')), {})) as Response
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('недоступны')
    expect(error.mock.calls.flat().join(' ')).toContain('REPORT_FILES')
    error.mockRestore()
  })

  it('пустой файл не принимает', async () => {
    const response = (await handleFiles(uploadRequest(new ArrayBuffer(0)), env())) as Response
    expect(response.status).toBe(400)
  })

  it('слишком большой файл отсекает по заголовку длины', async () => {
    const response = (await handleFiles(
      uploadRequest(bytes('a'), { 'Content-Length': String(9 * 1024 * 1024) }),
      env(),
    )) as Response
    expect(response.status).toBe(413)
  })
})

describe('GET /files/<id> — отдача файла', () => {
  it('возвращает файл вложением с читаемым именем', async () => {
    const store = stubStore()
    const uploaded = (await handleFiles(
      uploadRequest(bytes('xlsx-bytes'), { 'X-File-Name': encodeURIComponent('SelfCRM_Отчет.xlsx') }),
      { REPORT_FILES: store },
    )) as Response
    const { id } = (await uploaded.json()) as { id: string }

    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/${id}`),
      { REPORT_FILES: store },
    )) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(XLSX)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    // Имя с кириллицей передаётся и в ASCII-виде, и по RFC 5987 — иначе часть
    // клиентов сохранит файл без имени.
    const disposition = response.headers.get('Content-Disposition') ?? ''
    expect(disposition).toContain('attachment;')
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('SelfCRM_Отчет.xlsx')}`)
    expect(await response.text()).toBe('xlsx-bytes')
  })

  it('чужое имя файла не отдаёт', async () => {
    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/секрет`),
      env(),
    )) as Response
    expect(response.status).toBe(404)
  })

  it('имя файла в адресе не мешает отдаче', async () => {
    const store = stubStore()
    const uploaded = (await handleFiles(
      uploadRequest(bytes('xlsx-bytes'), { 'X-File-Name': encodeURIComponent('SelfCRM_Отчет.xlsx') }),
      { REPORT_FILES: store },
    )) as Response
    const { id } = (await uploaded.json()) as { id: string }

    // Такой адрес собирает Worker, когда готовит сообщение «Поделиться»: последним куском стоит
    // имя файла, по нему Telegram называет документ в чате. Отдаётся то же, что и без имени.
    const response = (await handleFiles(
      new Request(
        `https://selfcrm-bot.example.workers.dev${FILES_PATH}/${id}/${encodeURIComponent('SelfCRM_Отчет.xlsx')}`,
      ),
      { REPORT_FILES: store },
    )) as Response

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('xlsx-bytes')
  })

  it('имя в адресе не открывает чужой файл', async () => {
    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/секрет/имя.xlsx`),
      env(),
    )) as Response
    expect(response.status).toBe(404)
  })

  it('истёкший файл не отдаёт', async () => {
    const store = stubStore()
    const uploaded = (await handleFiles(uploadRequest(bytes('x')), {
      REPORT_FILES: store,
    })) as Response
    const { id } = (await uploaded.json()) as { id: string }
    await store.delete(id)
    await store.delete(`${id}:name`)

    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/${id}`),
      { REPORT_FILES: store },
    )) as Response
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('истёк')
  })

  it('подпись потерялась — файл всё равно отдаём', async () => {
    const store = stubStore()
    const uploaded = (await handleFiles(uploadRequest(bytes('x')), {
      REPORT_FILES: store,
    })) as Response
    const { id } = (await uploaded.json()) as { id: string }
    await store.delete(`${id}:name`)

    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/${id}`),
      { REPORT_FILES: store },
    )) as Response
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toContain('SelfCRM_')
  })

  it('имя и тип с чужими символами обезвреживаются', async () => {
    const store = stubStore()
    const uploaded = (await handleFiles(
      uploadRequest(bytes('payload'), {
        'X-File-Name': '..%2F..%2Fetc%2Fpasswd',
        'Content-Type': 'text/html',
      }),
      { REPORT_FILES: store },
    )) as Response
    const { id } = (await uploaded.json()) as { id: string }

    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/${id}`),
      { REPORT_FILES: store },
    )) as Response

    // Путь из имени не собирается, а тип не превращается в страницу, которую
    // браузер выполнит: html заменяется на поток байтов.
    expect(response.headers.get('Content-Disposition')).not.toContain('/etc/passwd')
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('HEAD не отдаёт тело, но сообщает о файле', async () => {
    const store = stubStore()
    const uploaded = (await handleFiles(uploadRequest(bytes('x')), {
      REPORT_FILES: store,
    })) as Response
    const { id } = (await uploaded.json()) as { id: string }

    const response = (await handleFiles(
      new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/${id}`, { method: 'HEAD' }),
      { REPORT_FILES: store },
    )) as Response
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})

describe('неподходящие методы', () => {
  it('GET на /files — 405', async () => {
    const request = new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}`)
    const response = (await handleFiles(request, env())) as Response
    expect(response.status).toBe(405)
  })

  it('PUT на файл — 405', async () => {
    const request = new Request(`https://selfcrm-bot.example.workers.dev${FILES_PATH}/abc`, {
      method: 'PUT',
    })
    const response = (await handleFiles(request, env())) as Response
    expect(response.status).toBe(405)
  })
})
