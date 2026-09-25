#!/usr/bin/env node
// Бот-лаунчер SelfCRM (@fastcrm_bot).
//
// Роль бота — только точка входа: он показывает кнопку «Открыть SelfCRM», которая
// запускает Telegram Mini App. Никакой CRM-логики в боте нет (см. PROMPT §15):
// клиенты, заказы и товары живут внутри Mini App и в локальном хранилище устройства.
//
// Зависимостей нет: используются встроенные в Node fetch и AbortController.
//
// Примеры:
//   node scripts/telegram-bot.mjs --setup    # один раз: команды /start, /help и кнопка меню
//   node scripts/telegram-bot.mjs            # запустить бота (long polling)
//
// Токен читается из окружения BOT_TOKEN или из локального .env (в git не попадает).
// В логи токен не выводится: любые сообщения об ошибках проходят через scrub().

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TELEGRAM_API = 'https://api.telegram.org'
const DEFAULT_WEBAPP_URL = 'https://doc9830.github.io/selfcrm-tg/'

const USAGE = `Бот-лаунчер SelfCRM.

Аргументы:
  --setup               задать команды бота и кнопку меню со ссылкой на Mini App
  --webapp-url <url>    адрес Mini App (по умолчанию ${DEFAULT_WEBAPP_URL})
  --help                эта справка

Окружение:
  BOT_TOKEN      токен @fastcrm_bot (иначе берётся из .env в корне проекта)
  WEBAPP_URL     адрес Mini App`

function parseArgs(argv) {
  const args = { setup: false, help: false, webappUrl: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--setup') args.setup = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--webapp-url') args.webappUrl = argv[++i] ?? null
  }
  return args
}

// Чтение .env без зависимостей: нужна одна переменная BOT_TOKEN.
function readEnvFile() {
  try {
    const text = readFileSync(join(ROOT, '.env'), 'utf8')
    const values = {}
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
    return values
  } catch {
    return {}
  }
}

const envFile = readEnvFile()

function resolveToken() {
  const token = process.env.BOT_TOKEN || envFile.BOT_TOKEN || ''
  if (!token) {
    throw new Error('Не задан BOT_TOKEN: положите его в переменную окружения или в локальный .env')
  }
  return token
}

// Токен не должен попадать в логи, даже в тексте ошибок Telegram.
function scrub(text) {
  const token = process.env.BOT_TOKEN || envFile.BOT_TOKEN
  return token ? String(text).split(token).join('***') : String(text)
}

async function call(method, payload, token) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })

  const json = await response.json().catch(() => null)
  if (!json || !json.ok) {
    const description = json?.description ? scrub(json.description) : `HTTP ${response.status}`
    throw new Error(`${method}: ${description}`)
  }
  return json.result
}

function webAppUrl(args) {
  return args.webappUrl || process.env.WEBAPP_URL || DEFAULT_WEBAPP_URL
}

// Тексты бота: обычный SelfCRM, который просто открывается внутри Telegram.
function startMessage() {
  return [
    'SelfCRM',
    '',
    'Ваша CRM прямо внутри Telegram.',
    '',
    'Клиенты, заказы, товары и напоминания. Данные хранятся на вашем устройстве —',
    'обычные операции работают без связи с нашими серверами.',
  ].join('\n')
}

function helpMessage(url) {
  return [
    'SelfCRM — справка',
    '',
    'Кнопка «Открыть SelfCRM» запускает приложение.',
    '',
    'Внутри приложения:',
    '• Клиенты и история заказов клиента;',
    '• Товары и склад;',
    '• Заказы и напоминания;',
    '• Статистика;',
    '• Настройки → Резервная копия: экспорт и импорт данных файлом.',
    '',
    'Основные данные CRM не хранятся на сервере SelfCRM: они сохраняются на',
    'устройстве. Делайте резервные копии, чтобы не потерять данные при смене',
    'устройства.',
    '',
    `Адрес Mini App: ${url}`,
  ].join('\n')
}

function keyboard(url) {
  return {
    inline_keyboard: [[{ text: 'Открыть SelfCRM', web_app: { url } }]],
  }
}

async function onUpdate(update, token, url) {
  const message = update.message
  if (!message) return
  const text = (message.text ?? '').trim()
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase()

  if (command === '/start') {
    await call(
      'sendMessage',
      { chat_id: message.chat.id, text: startMessage(), reply_markup: keyboard(url) },
      token,
    )
    return
  }

  if (command === '/help') {
    await call('sendMessage', { chat_id: message.chat.id, text: helpMessage(url) }, token)
    return
  }

  await call(
    'sendMessage',
    {
      chat_id: message.chat.id,
      text: 'Нажмите «Открыть SelfCRM» или отправьте /help.',
      reply_markup: keyboard(url),
    },
    token,
  )
}

// Команды бота и кнопка меню: после этого Mini App доступен из меню чата.
async function setup(token, url) {
  await call(
    'setMyCommands',
    {
      commands: [
        { command: 'start', description: 'Открыть SelfCRM' },
        { command: 'help', description: 'Справка' },
      ],
    },
    token,
  )

  await call(
    'setChatMenuButton',
    { menu_button: { type: 'web_app', text: 'Открыть SelfCRM', web_app: { url } } },
    token,
  )

  const me = await call('getMe', {}, token)
  console.log(`Готово: @${me.username} → ${url}`)
}

async function runPolling(token, url) {
  const me = await call('getMe', {}, token)
  console.log(`SelfCRM-бот @${me.username} запущен. Mini App: ${url}. Ctrl+C — остановить.`)

  const controller = new AbortController()
  const stop = () => {
    controller.abort()
    console.log('Остановка бота.')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  let offset = 0
  while (!controller.signal.aborted) {
    let updates
    try {
      updates = await withSignal(
        call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, token),
        controller.signal,
      )
    } catch (e) {
      if (controller.signal.aborted) break
      console.error(`Ошибка связи с Telegram: ${scrub(e.message)}`)
      await sleep(3000)
      continue
    }

    for (const update of updates) {
      offset = update.update_id + 1
      try {
        await onUpdate(update, token, url)
      } catch (e) {
        console.error(`Не удалось ответить на сообщение: ${scrub(e.message)}`)
      }
    }
  }
}

// Ожидание ответа Telegram прерывается по Ctrl+C: без этого бот не завершался бы
// до конца длинного опроса getUpdates.
function withSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('остановлено'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('остановлено'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const token = resolveToken()
  const url = webAppUrl(args)

  if (args.setup) {
    await setup(token, url)
    return
  }

  await runPolling(token, url)
}

main().catch((e) => {
  console.error(scrub(e instanceof Error ? e.message : e))
  process.exitCode = 1
})
