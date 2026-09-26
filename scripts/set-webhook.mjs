#!/usr/bin/env node
// Webhook бота @fastcrm_bot: установка, проверка и удаление.
//
//   npm run bot:webhook:set      — deleteWebhook + setWebhook на адрес Worker
//   npm run bot:webhook:info     — getWebhookInfo: куда Telegram шлёт обновления
//   npm run bot:webhook:delete   — deleteWebhook (бот перестанет получать обновления)
//
// Что нужно для установки:
//   BOT_TOKEN       — токен @fastcrm_bot (`.env` или переменная окружения);
//   WORKER_URL      — адрес развёрнутого Worker, например
//                     https://selfcrm-bot.<account>.workers.dev (`.env` или --url);
//   WEBHOOK_SECRET  — секрет webhook: берётся из `.env`, из --secret или создаётся
//                     и дописывается в `.env`. Telegram присылает его в заголовке
//                     X-Telegram-Bot-Api-Secret-Token, Worker его проверяет.
//
// Дополнительно:
//   --sync-secrets  залить BOT_TOKEN и WEBHOOK_SECRET в Cloudflare (`wrangler secret put`)
//
// Токен и секрет в вывод не попадают: печатаются только адрес и результат.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')
const TELEGRAM_API = 'https://api.telegram.org'

// Тот же путь, что слушает Worker (см. worker/src/index.ts).
const WEBHOOK_PATH = '/telegram/webhook'

// Обновления, которые нужны боту: сообщения (в т.ч. successful_payment и документы)
// и подтверждение оплаты. Всё остальное Telegram присылать не должен.
const ALLOWED_UPDATES = ['message', 'pre_checkout_query']

const USAGE = `Webhook бота @fastcrm_bot.

Аргументы:
  --set                 удалить старый webhook и поставить новый на Worker (по умолчанию)
  --info                показать getWebhookInfo
  --delete              удалить webhook (бот перестанет получать обновления)
  --url <url>           адрес Worker (по умолчанию WORKER_URL из .env)
  --secret <value>      секрет webhook (по умолчанию WEBHOOK_SECRET из .env)
  --sync-secrets        залить BOT_TOKEN и WEBHOOK_SECRET в Cloudflare
  --help                эта справка

Примеры:
  npm run bot:webhook:set -- --url https://selfcrm-bot.example.workers.dev
  npm run bot:webhook:set -- --sync-secrets
  npm run bot:webhook:info`

function parseArgs(argv) {
  const args = { action: 'set', url: null, secret: null, syncSecrets: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--set') args.action = 'set'
    else if (arg === '--info') args.action = 'info'
    else if (arg === '--delete') args.action = 'delete'
    else if (arg === '--url') args.url = argv[++i] ?? null
    else if (arg === '--secret') args.secret = argv[++i] ?? null
    else if (arg === '--sync-secrets') args.syncSecrets = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

// Чтение .env без зависимостей: BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL.
function readEnvFile() {
  try {
    const text = readFileSync(ENV_PATH, 'utf8')
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

let envFile = readEnvFile()

// Значение дописывается в .env, если его там нет: секрет нужен и боту, и Worker.
function remember(key, value) {
  if (envFile[key]) return
  let text = ''
  try {
    text = readFileSync(ENV_PATH, 'utf8')
  } catch {
    text = ''
  }
  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  writeFileSync(ENV_PATH, `${separator}${key}=${value}\n`, { flag: 'a' })
  envFile[key] = value
}

function resolveToken() {
  const token = process.env.BOT_TOKEN || envFile.BOT_TOKEN || ''
  if (!token) {
    throw new Error('Не задан BOT_TOKEN: положите его в переменную окружения или в .env')
  }
  return token
}

function resolveSecret(args) {
  const secret = args.secret || process.env.WEBHOOK_SECRET || envFile.WEBHOOK_SECRET || ''
  if (secret) return secret
  // Секрет должен быть случайным: Telegram ограничивает его набором A-Z a-z 0-9 _ -
  const created = randomBytes(24).toString('hex')
  remember('WEBHOOK_SECRET', created)
  console.log('Секрет webhook создан и записан в .env (WEBHOOK_SECRET).')
  return created
}

function webhookUrl(value) {
  const url = String(value ?? '').trim().replace(/\/+$/, '')
  if (!url) {
    throw new Error(
      'Не задан адрес Worker: укажите --url https://<worker>.<account>.workers.dev или добавьте WORKER_URL в .env',
    )
  }
  if (!/^https?:\/\//.test(url)) throw new Error(`Адрес Worker должен начинаться с https:// (получено: ${url})`)
  if (!url.startsWith('https://')) console.warn('Telegram принимает webhook только по HTTPS.')
  return `${url}${WEBHOOK_PATH}`
}

async function call(method, payload) {
  const token = resolveToken()
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const json = await response.json().catch(() => null)
  if (!json || !json.ok) {
    const description = json?.description
      ? String(json.description).split(token).join('***')
      : `HTTP ${response.status}`
    throw new Error(`${method}: ${description}`)
  }
  return json.result
}

// Секреты Worker: `wrangler secret put` читает значение со стандартного ввода, поэтому
// значения передаются процессу, а в консоль не попадают.
function pushSecret(name, value) {
  if (!value) {
    console.log(`Секрет ${name} не задан — пропускаю.`)
    return
  }
  console.log(`Заливаю секрет ${name} в Cloudflare…`)
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  })
  if (result.status !== 0) {
    throw new Error(
      `Не удалось залить ${name}: проверьте вход в Cloudflare (npx wrangler login) и имя Worker в wrangler.toml`,
    )
  }
}

function syncSecrets() {
  pushSecret('BOT_TOKEN', resolveToken())
  pushSecret('WEBHOOK_SECRET', envFile.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '')
}

async function showInfo() {
  const info = await call('getWebhookInfo', {})
  if (!info.url) {
    console.log('Webhook не установлен: обновления Telegram ждут, пока webhook не появится.')
    console.log('Поставить: npm run bot:webhook:set (адрес Worker — из WORKER_URL в .env или --url).')
    return
  }
  console.log(`Webhook: ${info.url}`)
  console.log(`Обновлений в очереди: ${info.pending_update_count ?? 0}`)
  if (info.allowed_updates?.length) {
    console.log(`Типы обновлений: ${info.allowed_updates.join(', ')}`)
  }
  if (info.last_error_message) {
    const when = info.last_error_date
      ? ` (${new Date(info.last_error_date * 1000).toLocaleString('ru-RU')})`
      : ''
    console.log(`Последняя ошибка доставки${when}: ${info.last_error_message}`)
    // Ошибка остаётся в истории Telegram даже после успешных доставок: пустая очередь важнее.
    if (!info.pending_update_count) {
      console.log('Очередь пуста, значит обновления доставляются: ошибка была раньше (например,')
      console.log('пока выкатывались секреты Worker). Проверить логи: npx wrangler tail')
    }
  }
}

async function deleteWebhook() {
  await call('deleteWebhook', { drop_pending_updates: false })
  console.log('Webhook удалён.')
  await showInfo()
}



async function setWebhook(args) {
  const urlArg = args.url || process.env.WORKER_URL || envFile.WORKER_URL
  const url = webhookUrl(urlArg)
  const secret = resolveSecret(args)

  if (!envFile.WORKER_URL && args.url) {
    remember('WORKER_URL', String(args.url).replace(/\/+$/, ''))
  }

  // Секреты Worker лучше задать до установки webhook: без них Telegram получит 403.
  if (args.syncSecrets) syncSecrets()

  // Сначала снимаем прежний webhook: Telegram не должен слать обновления и туда, и сюда.
  await call('deleteWebhook', { drop_pending_updates: false })
  await call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    // Уже накопившиеся обновления (например, никому не отправленный /start) не теряем.
    drop_pending_updates: false,
  })
  console.log(`Webhook установлен: ${url}`)
  await showInfo()

  if (!args.syncSecrets) {
    console.log('')
    console.log('Проверьте секреты Worker: BOT_TOKEN и WEBHOOK_SECRET должны быть заданы в Cloudflare.')
    console.log('Залить их одной командой: npm run bot:webhook:set -- --sync-secrets')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.action === 'info') await showInfo()
  else if (args.action === 'delete') await deleteWebhook()
  else await setWebhook(args)
}

main().catch((e) => {
  const token = process.env.BOT_TOKEN || envFile.BOT_TOKEN || ''
  const message = String(e?.message ?? e)
  console.error(token ? message.split(token).join('***') : message)
  process.exit(1)
})
