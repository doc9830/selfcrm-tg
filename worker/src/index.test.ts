import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { WEBHOOK_PATH } from './config'
import type { Env } from './telegram'

// Тесты входа Worker: проверка секрета webhook, разбор JSON и ответ Telegram.
//
// Ответ — это подтверждение доставки, поэтому проверяется именно HTTP-статус: 200 только
// тогда, когда обновление действительно обработано, 500 — когда обработка упала (Telegram
// повторит доставку). Тесты работают без сети: `fetch` подменяется заглушкой.

const env: Env = {
  BOT_TOKEN: '123456:TEST-TOKEN',
  WEBHOOK_SECRET: 'test-secret',
  WEBAPP_URL: 'https://example.test/app/',
}

// Адрес, по которому в тестах отвечает Worker: отдельной константой, потому что он нужен и
// запросам webhook, и запросам файлов.
const WEBHOOK_ORIGIN = 'https://selfcrm-bot.example.workers.dev'

const startUpdate = {
  update_id: 1001,
  message: { chat: { id: 42, type: 'private' }, text: '/start' },
}

const preCheckoutUpdate = {
  update_id: 1002,
  pre_checkout_query: {
    id: 'query-1',
    invoice_payload: 'selfcrm-support-100',
    total_amount: 100,
    from: { id: 42 },
  },
}

const paidUpdate = {
  update_id: 1003,
  message: {
    chat: { id: 42, type: 'private' },
    successful_payment: {
      invoice_payload: 'selfcrm-support-250',
      total_amount: 250,
      telegram_payment_charge_id: 'charge-1',
    },
  },
}

// Заглушка Bot API: пишет вызванные методы, отвечает как Telegram.
//   fail         — метод, на котором Bot API отвечает ошибкой (description — её текст);
//   networkError — метод, на котором падает сам fetch.
function stubFetch(
  log: string[],
  options: { fail?: string; description?: string; networkError?: string } = {},
) {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split('/').pop() ?? ''
    log.push(init?.body ? `${method} ${init.body}` : method)
    if (options.networkError === method) throw new Error('сеть недоступна')
    if (options.fail === method) {
      const description = options.description ?? `${method}: Bad Request`
      return new Response(JSON.stringify({ ok: false, description, error_code: 400 }), {
        status: 400,
      })
    }
    return new Response(JSON.stringify({ ok: true, result: true }))
  }
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch)
}

function webhookRequest(body: unknown, secret?: string, method = 'POST') {
  return new Request(`${WEBHOOK_ORIGIN}${WEBHOOK_PATH}`, {
    method,
    headers: secret === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

// Всё, что попало в консоль заглушкой spyOn: строки могут быть многострочными.
function loggedAs(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.flat().join(' ')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /telegram/webhook', () => {
  it('с правильным секретом обрабатывает обновление и отвечает 200', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), env)

    expect(response.status).toBe(200)
    expect(log.some((entry) => entry.startsWith('sendMessage') && entry.includes('Ваша CRM'))).toBe(true)
  })

  it('с неправильным секретом отвечает 403 и ничего не обрабатывает', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(webhookRequest(startUpdate, 'wrong-secret'), env)

    expect(response.status).toBe(403)
    expect(log).toEqual([])
  })

  it('без заголовка секрета отвечает 403', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(webhookRequest(startUpdate), env)

    expect(response.status).toBe(403)
    expect(log).toEqual([])
  })

  it('если WEBHOOK_SECRET не задан, отвечает 500', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), {
      ...env,
      WEBHOOK_SECRET: '',
    })

    expect(response.status).toBe(500)
    expect(log).toEqual([])
  })

  it('на некорректный JSON отвечает 400', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(
      new Request(`${WEBHOOK_ORIGIN}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
        body: '{не json',
      }),
      env,
    )

    expect(response.status).toBe(400)
  })

  it('на GET отвечает 405', async () => {
    const response = await worker.fetch(webhookRequest({}, 'test-secret', 'GET'), env)
    expect(response.status).toBe(405)
  })
})

describe('платежи', () => {
  it('pre_checkout_query подтверждается одним запросом и отвечает 200', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(webhookRequest(preCheckoutUpdate, 'test-secret'), env)

    expect(response.status).toBe(200)
    // Один вызов и никаких обращений к GitHub: ответить нужно за 10 секунд.
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('answerPreCheckoutQuery')
    expect(log[0]).toContain('"ok":true')
  })

  it('ошибка ответа на pre_checkout_query не выдаётся за успех: 500', async () => {
    const log: string[] = []
    stubFetch(log, { fail: 'answerPreCheckoutQuery' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(preCheckoutUpdate, 'test-secret'), env)

    expect(response.status).toBe(500)
    expect(loggedAs(error)).toContain('тип=pre_checkout_query')
  })

  it('successful_payment обрабатывается как раньше: благодарность и 200', async () => {
    const log: string[] = []
    stubFetch(log)
    const info = vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(paidUpdate, 'test-secret'), env)

    expect(response.status).toBe(200)
    expect(
      log.some((entry) => entry.startsWith('sendMessage') && entry.includes('Спасибо')),
    ).toBe(true)
    // charge_id по-прежнему попадает в лог: без него не вернуть звёзды.
    expect(loggedAs(info)).toContain('charge-1')
  })
})

describe('неподдерживаемое обновление', () => {
  it('неизвестный тип: отвечает 200 и ничего не вызывает', async () => {
    const log: string[] = []
    stubFetch(log)

    const response = await worker.fetch(webhookRequest({ update_id: 1004 }, 'test-secret'), env)

    expect(response.status).toBe(200)
    expect(log).toEqual([])
  })
})

describe('прочие адреса', () => {
  it('на неизвестный путь отвечает 404', async () => {
    const response = await worker.fetch(
      new Request(`${WEBHOOK_ORIGIN}/чужой-путь`, { method: 'POST' }),
      env,
    )
    expect(response.status).toBe(404)
  })

  it('GET / отвечает 200 — проверка, что Worker развёрнут', async () => {
    const response = await worker.fetch(
      new Request(`${WEBHOOK_ORIGIN}/`),
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('works')
  })
})

describe('POST /files/<id>/share', () => {
  it('доходит до слоя «Поделиться», а не до слоя файлов: без подписи — 403', async () => {
    // Путь начинается так же, как у файлов, поэтому важно, что запрос перехватывает именно
    // слой «Поделиться»: слой файлов ответил бы 404, и кнопка в мини-приложении не работала бы.
    const log: string[] = []
    stubFetch(log)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const withStore: Env = {
      ...env,
      REPORT_FILES: {
        async put() {},
        async get() {
          return null
        },
        async delete() {},
      },
    }

    const response = await worker.fetch(
      new Request(`${WEBHOOK_ORIGIN}/files/${'a'.repeat(22)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: 'мусор' }),
      }),
      withStore,
    )

    expect(response.status).toBe(403)
    // Bot API не вызывается вовсе: неподписанный запрос дальше не идёт.
    expect(log).toEqual([])
  })
})

describe('ошибка обработки обновления', () => {
  it('ошибка Bot API: отвечает 500, а не подтверждает доставку', async () => {
    const log: string[] = []
    stubFetch(log, { fail: 'sendMessage' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), env)

    expect(response.status).toBe(500)
    const logged = loggedAs(error)
    expect(logged).toContain('Обновление не обработано')
    expect(logged).toContain('update_id=1001')
    expect(logged).toContain('тип=message')
    expect(logged).toContain('sendMessage')
  })

  it('сетевая ошибка fetch: отвечает 500', async () => {
    const log: string[] = []
    stubFetch(log, { networkError: 'sendMessage' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), env)

    expect(response.status).toBe(500)
    expect(loggedAs(error)).toContain('сеть недоступна')
  })

  it('в лог не попадают токен, секрет webhook и тело обновления', async () => {
    const log: string[] = []
    stubFetch(log, {
      fail: 'sendMessage',
      description: 'Bad Request: токен 123456:TEST-TOKEN и секрет test-secret',
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), env)

    expect(response.status).toBe(500)
    const logged = loggedAs(error)
    expect(logged).toContain('***')
    expect(logged).not.toContain('123456:TEST-TOKEN')
    expect(logged).not.toContain('test-secret')
    // Тело обновления не пишется: в нём бывают тексты пользователя и платёжные данные.
    expect(logged).not.toContain('/start')
  })

  it('ошибка кнопки меню не срывает ответ: обновление обработано → 200', async () => {
    const log: string[] = []
    stubFetch(log, { fail: 'setChatMenuButton' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), env)

    // Кнопка меню — идемпотентная настройка: её ошибка попадает в лог, но ответ /start уходит.
    expect(response.status).toBe(200)
    expect(log.some((entry) => entry.startsWith('sendMessage'))).toBe(true)
    expect(loggedAs(error)).toContain('setChatMenuButton')
  })
})
