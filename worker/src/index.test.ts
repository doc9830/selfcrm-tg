import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { WEBHOOK_PATH } from './index'
import type { Env } from './telegram'

// Тесты входа Worker: проверка секрета webhook, разбор JSON и ответ Telegram HTTP 200
// (Cloud.md §Безопасность webhook, §Тестирование).

const env: Env = {
  BOT_TOKEN: '123456:TEST-TOKEN',
  WEBHOOK_SECRET: 'test-secret',
  WEBAPP_URL: 'https://example.test/app/',
}

const startUpdate = {
  message: { chat: { id: 42, type: 'private' }, text: '/start' },
}

// Заглушка Bot API: пишет вызванные методы, отвечает как Telegram.
function stubFetch(log: string[], failure?: { description: string }) {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split('/').pop() ?? ''
    log.push(init?.body ? `${method} ${init.body}` : method)
    if (method === 'setChatMenuButton') return new Response(JSON.stringify({ ok: true, result: true }))
    if (failure) {
      return new Response(JSON.stringify({ ok: false, description: failure.description, error_code: 400 }), {
        status: 400,
      })
    }
    return new Response(JSON.stringify({ ok: true, result: true }))
  }
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch)
}

function webhookRequest(body: unknown, secret?: string, method = 'POST') {
  return new Request(`https://selfcrm-bot.example.workers.dev${WEBHOOK_PATH}`, {
    method,
    headers: secret === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
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
      new Request(`https://selfcrm-bot.example.workers.dev${WEBHOOK_PATH}`, {
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

describe('прочие адреса', () => {
  it('на неизвестный путь отвечает 404', async () => {
    const response = await worker.fetch(
      new Request('https://selfcrm-bot.example.workers.dev/чужой-путь', { method: 'POST' }),
      env,
    )
    expect(response.status).toBe(404)
  })

  it('GET / отвечает 200 — проверка, что Worker развёрнут', async () => {
    const response = await worker.fetch(
      new Request('https://selfcrm-bot.example.workers.dev/'),
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('works')
  })
})

describe('ошибка Telegram API', () => {
  it('не срывает ответ Telegram и не раскрывает токен в логе', async () => {
    const log: string[] = []
    stubFetch(log, { description: 'Bad Request: chat not found (токен 123456:TEST-TOKEN)' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await worker.fetch(webhookRequest(startUpdate, 'test-secret'), env)

    expect(response.status).toBe(200)
    const logged = error.mock.calls.flat().join(' ')
    expect(logged).toContain('sendMessage')
    expect(logged).toContain('***')
    expect(logged).not.toContain('123456:TEST-TOKEN')
  })
})
