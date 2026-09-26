import { describe, expect, it, vi } from 'vitest'
import { handleUpdate } from './handler'
import type { Env } from './telegram'

// Тесты проверяют поведение бота целиком (Cloud.md §Тестирование): обновление Telegram на
// входе — вызовы Bot API на выходе. Сети нет: fetch подменяется заглушкой, которая пишет
// вызовы в массив, а на методы Telegram отвечает как настоящий api.telegram.org.

const env: Env = {
  BOT_TOKEN: '123456:TEST-TOKEN',
  WEBHOOK_SECRET: 'test-secret',
  WEBAPP_URL: 'https://example.test/app/',
}

interface Call {
  method: string
  payload: Record<string, any>
}

const release = {
  tag_name: 'v1.6.0',
  name: 'SelfCRM 1.6.0',
  body: '## Что нового\n\n- Подсказка на пустой базе\n\n**Source available**',
  html_url: 'https://github.com/doc9830/SelfCRM/releases/tag/v1.6.0',
  published_at: '2026-09-26T10:00:00Z',
}

function jsonResponse(result: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify({ ok, result }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// GitHub отвечает не обёрткой Telegram, а самим объектом релиза.
function rawResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Заглушка сети: GitHub отдаёт релиз, методы Telegram — ответы из overrides.
function stubFetch(overrides: Record<string, unknown | Error> = {}) {
  const calls: Call[] = []

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.includes('api.github.com')) {
      if (overrides.github instanceof Error) throw overrides.github
      return rawResponse(overrides.github === undefined ? release : overrides.github)
    }

    const method = url.split('/').pop() ?? ''
    const payload = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, payload })

    const override = overrides[method]
    if (override instanceof Error) throw override
    if (override !== undefined) return jsonResponse(override)

    // createInvoiceLink должен вернуть ссылку: по ней строится кнопка со счётом.
    if (method === 'createInvoiceLink') {
      return jsonResponse(`https://t.me/$/${payload.prices?.[0]?.amount}`)
    }
    return jsonResponse(true)
  }

  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

function message(chatId: number, text?: string, extra: Record<string, unknown> = {}) {
  return { message: { chat: { id: chatId, type: 'private' }, text, ...extra } }
}

async function run(update: unknown, overrides: Record<string, unknown | Error> = {}) {
  const stub = stubFetch(overrides)
  await handleUpdate(update as any, env, { fetch: stub.fetchImpl })
  return stub.calls
}

function sent(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'sendMessage')
}

function sentTexts(calls: Call[]): string[] {
  return sent(calls).map((call) => call.payload.text)
}

describe('/start', () => {
  it('отвечает приветствием и клавиатурой со ссылками проекта', async () => {
    const calls = await run(message(42, '/start'))

    const texts = sentTexts(calls)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Ваша CRM прямо внутри Telegram.')
    expect(texts[0]).toContain('Данные хранятся на вашем устройстве')

    const buttons = sent(calls)[0].payload.reply_markup.inline_keyboard
    expect(buttons[0][0]).toEqual({
      text: 'Открыть SelfCRM',
      web_app: { url: 'https://example.test/app/' },
    })
    expect(buttons[1]).toEqual([
      { text: 'GitHub', url: 'https://github.com/doc9830/SelfCRM' },
      { text: 'Лендинг', url: 'https://doc9830.github.io/SelfCRMlanding/' },
    ])
    expect(buttons[2]).toEqual([{ text: 'Группа SelfCRM', url: 'https://t.me/selfcrmtg' }])
  })

  it('ставит кнопку меню в личном чате перед ответом', async () => {
    const calls = await run(message(42, '/start'))

    const menu = calls.find((call) => call.method === 'setChatMenuButton')
    expect(menu?.payload).toEqual({
      chat_id: 42,
      menu_button: {
        type: 'web_app',
        text: 'Открыть SelfCRM',
        web_app: { url: 'https://example.test/app/' },
      },
    })
  })

  it('/start support сразу присылает счёт', async () => {
    const calls = await run(message(42, '/start support'))

    expect(calls.filter((call) => call.method === 'createInvoiceLink')).toHaveLength(4)
    expect(sentTexts(calls)[1]).toContain('❤️ Поддержать SelfCRM')
  })

  it('в группе кнопка меню не ставится', async () => {
    const calls = await run({ message: { chat: { id: -100, type: 'group' }, text: '/start' } })

    expect(calls.some((call) => call.method === 'setChatMenuButton')).toBe(false)
    expect(sentTexts(calls)).toHaveLength(1)
  })
})

describe('/help', () => {
  it('перечисляет команды, ссылки и адрес Mini App', async () => {
    const calls = await run(message(7, '/help'))
    const text = sentTexts(calls)[0]

    expect(text).toContain('SelfCRM — справка')
    expect(text).toContain('/whatsnew — что нового в последней версии;')
    expect(text).toContain('• GitHub — исходный код: https://github.com/doc9830/SelfCRM')
    expect(text).toContain(
      '• Лендинг — возможности и установка: https://doc9830.github.io/SelfCRMlanding/',
    )
    expect(text).toContain('• Группа SelfCRM — вопросы и обсуждения: https://t.me/selfcrmtg')
    expect(text).toContain('Адрес Mini App: https://example.test/app/')
  })

  it('понимает команду с именем бота', async () => {
    const calls = await run(message(7, '/help@fastcrm_bot'))
    expect(sentTexts(calls)[0]).toContain('SelfCRM — справка')
  })
})

describe('/support', () => {
  it('создаёт четыре счёта звёздами и присылает кнопки с суммами', async () => {
    const calls = await run(message(7, '/support'))

    const invoices = calls.filter((call) => call.method === 'createInvoiceLink')
    expect(invoices.map((call) => call.payload.prices[0].amount)).toEqual([50, 100, 250, 500])
    expect(invoices[0].payload).toMatchObject({
      title: 'Поддержка SelfCRM',
      description: 'Поддержать разработку SelfCRM: 50 ⭐',
      payload: 'selfcrm-support-50',
      currency: 'XTR',
    })

    const messageCall = sent(calls)[0]
    expect(messageCall.payload.text).toContain('Оплата — звёздами Telegram, разово, без подписки.')
    expect(messageCall.payload.reply_markup.inline_keyboard[0]).toEqual([
      { text: '50 ⭐', url: 'https://t.me/$/50' },
      { text: '100 ⭐', url: 'https://t.me/$/100' },
      { text: '250 ⭐', url: 'https://t.me/$/250' },
      { text: '500 ⭐', url: 'https://t.me/$/500' },
    ])
  })
})

describe('/paysupport', () => {
  it('объясняет, как получить помощь и возврат', async () => {
    const calls = await run(message(7, '/paysupport'))
    const text = sentTexts(calls)[0]

    expect(text).toContain('Оплата и возврат')
    expect(text).toContain('«Настройки → Мои звёзды → История платежей»')
    expect(text).toContain('doc9830@proton.me')
  })
})

describe('/whatsnew', () => {
  it('присылает changelog последнего релиза без markdown-разметки', async () => {
    const calls = await run(message(7, '/whatsnew'))
    const text = sentTexts(calls)[0]

    expect(text).toContain('🚀 Что нового')
    expect(text).toContain('SelfCRM 1.6.0')
    expect(text).toMatch(/Опубликовано: 26 сентября 2026/)
    expect(text).toContain('• Подсказка на пустой базе')
    expect(text).not.toContain('##')
    expect(text).not.toContain('**')
    expect(sent(calls)[0].payload.reply_markup.inline_keyboard[1]).toEqual([
      { text: 'Релиз на GitHub', url: 'https://github.com/doc9830/SelfCRM/releases/tag/v1.6.0' },
    ])
  })

  it('если GitHub не ответил, даёт ссылку на релизы', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = await run(message(7, '/whatsnew'), { github: new Error('сеть недоступна') })
    const text = sentTexts(calls)[0]

    expect(text).toContain('Список изменений не удалось получить с GitHub.')
    expect(text).toContain('https://github.com/doc9830/SelfCRM/releases')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})


describe('документ и обычный текст', () => {
  it('на присланный файл подсказывает, как восстановить копию', async () => {
    const calls = await run(message(7, undefined, { document: { file_id: 'abc' } }))
    const text = sentTexts(calls)[0]

    expect(text).toContain('Восстановить из файла')
    expect(text).toContain('Файл копии останется в этом чате')
  })

  it('на текст без команды просит нажать кнопку или отправить /help', async () => {
    const calls = await run(message(7, 'привет'))
    expect(sentTexts(calls)[0]).toBe('Нажмите «Открыть SelfCRM» или отправьте /help.')
  })

  it('обновление без сообщения ничего не отправляет', async () => {
    expect(await run({ update_id: 1 })).toEqual([])
  })
})

describe('платежи', () => {
  it('pre_checkout_query подтверждается сразу и без лишних запросов', async () => {
    const calls = await run({
      pre_checkout_query: {
        id: 'query-1',
        invoice_payload: 'selfcrm-support-100',
        total_amount: 100,
        from: { id: 42 },
      },
    })

    expect(calls).toEqual([
      {
        method: 'answerPreCheckoutQuery',
        payload: { pre_checkout_query_id: 'query-1', ok: true },
      },
    ])
  })

  it('successful_payment получает благодарность', async () => {
    const calls = await run(
      message(7, undefined, {
        successful_payment: {
          invoice_payload: 'selfcrm-support-250',
          total_amount: 250,
          telegram_payment_charge_id: 'charge-1',
        },
      }),
    )

    expect(sentTexts(calls)[0]).toContain('Спасибо! ❤️')
    expect(sentTexts(calls)[0]).toContain('/paysupport')
  })
})
