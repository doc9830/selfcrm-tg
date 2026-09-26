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
//   node scripts/telegram-bot.mjs --whatsnew # посмотреть текст «что нового» без отправки
//
// Команда /whatsnew читает последний релиз Android-версии (doc9830/SelfCRM) через публичный
// GitHub API и присылает changelog. Сам Mini App берётся с GitHub Pages и обновляется сам,
// поэтому кнопка в ответе всегда открывает новую версию — релизов и переустановки нет.
//
// К каждому ответу бот добавляет кнопки со ссылками проекта: GitHub (исходный код), лендинг
// и группу SelfCRM для вопросов — в /help те же адреса перечислены текстом.
//
// Ещё бот принимает поддержку проекта звёздами Telegram: /support присылает счета на
// 50/100/250/500 ⭐, оплату подтверждает pre_checkout_query (ответ за 10 секунд), а о
// полученных звёздах пишет в лог `telegram_payment_charge_id` — он нужен для возврата.
// Ссылки на те же счета открывает плашка «Поддержите разработку» в мини-приложении;
// печатает их `npm run bot -- --star-links` (готовый блок для src/utils/support.ts).
//
// Кнопка меню ставится в двух местах: как общая (по умолчанию, для всех пользователей) и
// у конкретного чата — сразу после первого сообщения боту. Так кнопка появляется даже там,
// где Telegram не применил общую настройку (см. menuButtonHint).
//
// Токен читается из окружения BOT_TOKEN или из локального .env (в git не попадает).
// В логи токен не выводится: любые сообщения об ошибках проходят через scrub().

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TELEGRAM_API = 'https://api.telegram.org'
const DEFAULT_WEBAPP_URL = 'https://doc9830.github.io/selfcrm-tg/'

// Релизы Android-версии: публичный API, токен не нужен. Список изменений живёт там,
// а Mini App обновляется сам с GitHub Pages — /whatsnew только рассказывает, что нового.
const RELEASES_API = 'https://api.github.com/repos/doc9830/SelfCRM/releases'
const RELEASES_URL = 'https://github.com/doc9830/SelfCRM/releases'
const GITHUB_USER_AGENT = 'selfcrm-telegram-bot'

// Постоянные ссылки проекта. Бот добавляет их кнопками к каждому ответу (см. keyboard),
// а в /help перечисляет текстом: исходный код, лендинг с описанием и установкой и группа
// SelfCRM для вопросов — это публичная группа-обсуждение канала SelfCRM.
const GITHUB_URL = 'https://github.com/doc9830/SelfCRM'
const LANDING_URL = 'https://doc9830.github.io/SelfCRMlanding/'
const GROUP_URL = 'https://t.me/selfcrmtg'

// Ответ GitHub кэшируется: лимит для неавторизованных запросов — 60 в час с одного IP.
const RELEASE_CACHE_MS = 10 * 60 * 1000
let releaseCache = { at: 0, value: null }

const USAGE = `Бот-лаунчер SelfCRM.

Аргументы:
  --setup               задать команды бота и кнопку меню со ссылкой на Mini App
  --webapp-url <url>    адрес Mini App (по умолчанию ${DEFAULT_WEBAPP_URL})
  --chat <id>           задать кнопку меню для чата (можно повторять: --chat 123 --chat 456)
  --whatsnew            показать текст «что нового» и выйти (ничего не отправляется)
  --star-links          создать ссылки на оплату звёздами и напечатать для src/utils/support.ts
  --help                эта справка

Окружение:
  BOT_TOKEN      токен @fastcrm_bot (иначе берётся из .env в корне проекта)
  WEBAPP_URL     адрес Mini App`

const MENU_BUTTON_TEXT = 'Открыть SelfCRM'

// Поддержка проекта: суммы в звёздах Telegram. Значения совпадают с SUPPORT_AMOUNTS
// в src/utils/support.ts — там же лежат ссылки, которые создаёт --star-links.
const SUPPORT_AMOUNTS = [50, 100, 250, 500]

// Что за товар продаём: так подписаны счёт и платёжный лист.
const SUPPORT_TITLE = 'Поддержка SelfCRM'
const SUPPORT_DESCRIPTION = 'Поддержать разработку SelfCRM'
// Одна и та же строка payload у всех счетов: по ней видно, что платёж — поддержка.
const SUPPORT_PAYLOAD = 'selfcrm-support'

function parseArgs(argv) {
  const args = {
    setup: false,
    help: false,
    whatsnew: false,
    starLinks: false,
    webappUrl: null,
    chats: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--setup') args.setup = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--whatsnew') args.whatsnew = true
    else if (arg === '--star-links') args.starLinks = true
    else if (arg === '--webapp-url') args.webappUrl = argv[++i] ?? null
    else if (arg === '--chat') {
      const chatId = Number(argv[++i])
      if (Number.isFinite(chatId) && chatId !== 0) args.chats.push(chatId)
    }
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

// Последний опубликованный релиз Android-версии. Черновики и пререлизы GitHub в /latest
// не отдаёт, поэтому в ответе всегда то, что реально вышло. Ошибка — на совести вызывающего.
async function latestRelease() {
  if (releaseCache.value && Date.now() - releaseCache.at < RELEASE_CACHE_MS) return releaseCache.value
  const response = await fetch(`${RELEASES_API}/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': GITHUB_USER_AGENT },
  })
  if (!response.ok) throw new Error(`GitHub releases: HTTP ${response.status}`)
  const release = await response.json()
  if (!release?.tag_name) throw new Error('GitHub releases: пустой ответ')
  releaseCache = { at: Date.now(), value: release }
  return release
}

// Описание релиза — markdown, а бот отправляет сообщения без parse_mode. Разметку снимаем:
// заголовки и списки остаются читаемыми, а **звёздочки** и `кавычки` в чат не попадают.
function markdownToText(markdown) {
  return String(markdown ?? '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Лимит сообщения Telegram — 4096 символов; оставляем запас на заголовок и подписи.
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`
}

function formatDate(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

// «Что нового»: changelog последнего релиза. Отдельно проговаривается главное для Mini App —
// он берётся с GitHub Pages и обновляется сам, поэтому обновлять вручную нечего.
function whatsnewMessage(release) {
  const lines = ['🚀 Что нового', '', release.name || `SelfCRM ${release.tag_name}`]
  if (release.published_at) lines.push(`Опубликовано: ${formatDate(release.published_at)}`)
  lines.push('', truncate(markdownToText(release.body), 3200) || 'Описание релиза пустое — подробности на странице релиза.', '')
  lines.push(
    'Mini App открывается с GitHub Pages и обновляется сам: новая версия уже внутри —',
    'обновлять или переустанавливать ничего не нужно.',
  )
  return lines.join('\n')
}

function whatsnewKeyboard(url, releaseUrl) {
  return {
    inline_keyboard: [
      [{ text: MENU_BUTTON_TEXT, web_app: { url } }],
      [{ text: 'Релиз на GitHub', url: releaseUrl }],
    ],
  }
}

async function sendWhatsnew(chatId, token, url) {
  try {
    const release = await latestRelease()
    await call(
      'sendMessage',
      {
        chat_id: chatId,
        text: whatsnewMessage(release),
        reply_markup: whatsnewKeyboard(url, release.html_url || RELEASES_URL),
      },
      token,
    )
  } catch (e) {
    // Сеть и лимит запросов GitHub — не повод молчать: даём ссылку на релизы.
    console.error(`Список изменений не получен: ${scrub(e.message)}`)
    await call(
      'sendMessage',
      {
        chat_id: chatId,
        text: ['Список изменений не удалось получить с GitHub.', `Страница релизов: ${RELEASES_URL}`].join('\n'),
        reply_markup: keyboard(url),
      },
      token,
    )
  }
}

// ----- Поддержка проекта звёздами Telegram -----
//
// Приём платежей устроен по документации Telegram: бот продаёт цифровые товары, а значит
// оплата идёт только звёздами (currency XTR). Порядок такой:
//   1. ссылку на счёт создаёт `createInvoiceLink`; из неё платёжный лист открывает клиент
//      (в мини-приложении это WebApp.openInvoice, см. src/utils/support.ts);
//   2. перед оплатой приходит `pre_checkout_query` — ответить нужно за 10 секунд
//      (`answerPreCheckoutQuery`), иначе платёж не пройдёт;
//   3. после оплаты приходит `successful_payment` — за него благодарим и пишем в лог
//      `telegram_payment_charge_id`: только с ним можно вернуть звёзды.
//
// Пока процесс бота не запущен, подтверждать платежи некому — поэтому поддержка работает
// тогда, когда запущен `npm run bot` (как и остальные ответы бота).
const SUPPORT_EMAIL = 'doc9830@proton.me'

// Ссылки на счета создаются один раз за запуск и живут в памяти: `createInvoiceLink`
// вызывается на сумму, а не на каждое нажатие. Ссылки постоянные — открывать их можно
// многократно, каждый платёж приходит отдельным `successful_payment`.
let starLinksCache = null

async function starLinks(token) {
  if (starLinksCache) return starLinksCache
  const links = {}
  for (const amount of SUPPORT_AMOUNTS) {
    links[amount] = await call(
      'createInvoiceLink',
      {
        title: SUPPORT_TITLE,
        description: `${SUPPORT_DESCRIPTION}: ${amount} ⭐`,
        payload: `${SUPPORT_PAYLOAD}-${amount}`,
        currency: 'XTR',
        prices: [{ label: SUPPORT_TITLE, amount }],
      },
      token,
    )
  }
  starLinksCache = links
  return links
}

// Текст поддержки: суммы выводятся кнопками — за каждой кнопкой ссылка на счёт.
function supportMessage() {
  return [
    '❤️ Поддержать SelfCRM',
    '',
    'SelfCRM бесплатный и без ограничений. Поддержка помогает проекту жить:',
    'исправлять ошибки, добавлять возможности и держать приложение в порядке.',
    '',
    'Оплата — звёздами Telegram, разово, без подписки. Выберите сумму:',
  ].join('\n')
}

function supportKeyboard(links) {
  return {
    inline_keyboard: [SUPPORT_AMOUNTS.map((amount) => ({ text: `${amount} ⭐`, url: links[amount] }))],
  }
}

async function sendSupport(chatId, token) {
  const links = await starLinks(token)
  await call(
    'sendMessage',
    { chat_id: chatId, text: supportMessage(), reply_markup: supportKeyboard(links) },
    token,
  )
}

// /paysupport — обязательная команда для ботов, которые продают цифровые товары: по ней
// пользователь должен понять, как получить помощь и возврат.
function paysupportMessage() {
  return [
    'Оплата и возврат',
    '',
    'Поддержка проекта идёт звёздами Telegram. Чек об оплате остаётся в самом Telegram:',
    '«Настройки → Мои звёзды → История платежей».',
    '',
    'Если платёж прошёл, а что-то не работает, или нужен возврат — напишите на',
    `${SUPPORT_EMAIL} и укажите дату платежа: вернём звёзды (refundStarPayment).`,
  ].join('\n')
}

// Подтверждение оплаты: ответ отправляется сразу и без лишних запросов — на ответ
// Telegram даёт 10 секунд, иначе платёж отменяется.
async function onPreCheckout(query, token) {
  await call('answerPreCheckoutQuery', { pre_checkout_query_id: query.id, ok: true }, token)
  console.log(
    `Оплата подтверждена: ${query.invoice_payload}, ${query.total_amount} ⭐ (пользователь ${query.from?.id ?? '—'})`,
  )
}

// Полученная оплата: благодарим и пишем в лог charge_id — он нужен для возврата звёзд.
async function onPaid(message, token, url) {
  const payment = message.successful_payment
  console.log(
    `Оплата получена: ${payment.invoice_payload}, ${payment.total_amount} ⭐, charge ${payment.telegram_payment_charge_id}`,
  )
  await call(
    'sendMessage',
    {
      chat_id: message.chat.id,
      text: [
        'Спасибо! ❤️',
        '',
        'Звёзды пришли — поддержка засчитана. Вопросы по оплате: /paysupport.',
      ].join('\n'),
      reply_markup: keyboard(url),
    },
    token,
  )
}

// Тексты бота: обычный SelfCRM, который просто открывается внутри Telegram.
// Ссылки дублируются кнопками (keyboard), поэтому в тексте они не перечисляются.
function startMessage() {
  return [
    'SelfCRM',
    '',
    'Ваша CRM прямо внутри Telegram.',
    '',
    'Клиенты, заказы, товары и напоминания. Данные хранятся на вашем устройстве —',
    'обычные операции работают без связи с нашими серверами.',
    '',
    'Исходный код, описание возможностей и группа SelfCRM для вопросов —',
    'кнопками ниже.',
  ].join('\n')
}

function helpMessage(url) {
  return [
    'SelfCRM — справка',
    '',
    'Кнопка «Открыть SelfCRM» запускает приложение.',
    '',
    'Команды бота:',
    '/whatsnew — что нового в последней версии;',
    '/support — поддержать разработку звёздами Telegram;',
    '/paysupport — помощь и возврат по оплате;',
    '/help — эта справка.',
    '',
    'Внутри приложения:',
    '• Клиенты и история заказов клиента;',
    '• Товары и склад;',
    '• Заказы и напоминания;',
    '• Статистика;',
    '• Настройки → Резервная копия: «Сохранить и открыть чат» — файл копии',
    '  сохранится на устройстве, а этот чат откроется; прикрепите файл сюда',
    '  (📎 → Файл) — копия останется в истории чата.',
    '',
    'Основные данные CRM не хранятся на сервере SelfCRM: они сохраняются на',
    'устройстве. Делайте резервные копии, чтобы не потерять данные при смене',
    'устройства. Файл копии можно отправить в этот чат — он останется в истории',
    'чата и его можно будет вернуть импортом.',
    '',
    'Ссылки:',
    `• GitHub — исходный код: ${GITHUB_URL}`,
    `• Лендинг — возможности и установка: ${LANDING_URL}`,
    `• Группа SelfCRM — вопросы и обсуждения: ${GROUP_URL}`,
    '',
    'Поддержать проект: /support — разовая оплата звёздами Telegram, без подписки.',
    '',
    `Адрес Mini App: ${url}`,
  ].join('\n')
}

// Документ, присланный боту, — резервная копия CRM. Бот её не скачивает (getFile не
// вызывается) и нигде не хранит: файл остаётся в истории чата у самого пользователя.
// Здесь только подсказка, как вернуть данные из такой копии.
function backupMessage() {
  return [
    'Файл копии останется в этом чате — его можно скачать в любой момент, в том',
    'числе на другом устройстве.',
    '',
    'Чтобы вернуть данные: SelfCRM → Настройки → Резервная копия →',
    '«Восстановить из файла» и выберите этот файл.',
  ].join('\n')
}

// Клавиатура ответа: запуск Mini App, а под ним — постоянные ссылки проекта.
// Кнопка с web_app работает только в личном чате; ссылки — где угодно.
function keyboard(url) {
  return {
    inline_keyboard: [
      [{ text: MENU_BUTTON_TEXT, web_app: { url } }],
      [
        { text: 'GitHub', url: GITHUB_URL },
        { text: 'Лендинг', url: LANDING_URL },
      ],
      [{ text: 'Группа SelfCRM', url: GROUP_URL }],
    ],
  }
}

async function onUpdate(update, token, url) {
  // Подтверждение оплаты приходит отдельным обновлением, а не сообщением: ответить на него
  // нужно за 10 секунд, поэтому оно обрабатывается раньше всего остального.
  if (update.pre_checkout_query) {
    await onPreCheckout(update.pre_checkout_query, token)
    return
  }

  const message = update.message
  if (!message) return

  // Успешная оплата — тоже сообщение, но без текста: только поле successful_payment.
  if (message.successful_payment) {
    await onPaid(message, token, url)
    return
  }

  const text = (message.text ?? '').trim()
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase()

  if (command === '/start') {
    await call(
      'sendMessage',
      { chat_id: message.chat.id, text: startMessage(), reply_markup: keyboard(url) },
      token,
    )
    // Ссылка из плашки поддержки в приложении ведёт сюда: /start support → сразу счёт.
    if (text.split(/\s+/)[1]?.toLowerCase() === 'support') {
      await sendSupport(message.chat.id, token)
    }
    return
  }

  // Поддержка проекта: суммы звёздами кнопками, каждая кнопка — ссылка на счёт.
  if (command === '/support') {
    await sendSupport(message.chat.id, token)
    return
  }

  // Обязательная команда для ботов с цифровыми товарами: помощь и возврат по оплате.
  if (command === '/paysupport') {
    await call(
      'sendMessage',
      { chat_id: message.chat.id, text: paysupportMessage(), reply_markup: keyboard(url) },
      token,
    )
    return
  }

  if (command === '/help') {
    await call(
      'sendMessage',
      { chat_id: message.chat.id, text: helpMessage(url), reply_markup: keyboard(url) },
      token,
    )
    return
  }

  // «Что нового»: бот читает последний релиз Android-версии и присылает changelog.
  if (command === '/whatsnew') {
    await sendWhatsnew(message.chat.id, token, url)
    return
  }

  // Присланный файл — резервная копия CRM: отвечаем подсказкой, как её вернуть.
  // Автоматического поиска копий в истории нет: бот не читает переписку и не хранит файлы.
  if (message.document) {
    await call(
      'sendMessage',
      { chat_id: message.chat.id, text: backupMessage(), reply_markup: keyboard(url) },
      token,
    )
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

function menuButton(url) {
  return { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url } }
}

// Telegram отвечает true и на те запросы, которые не применяет сразу: кнопка меню по умолчанию
// обновляется с задержкой, поэтому значение перечитывается, а если прежнее ещё на месте —
// печатается подсказка, а не бодрый отчёт об успехе.
function menuButtonHint(current, url) {
  return [
    `Кнопку меню по умолчанию Telegram пока не применил: сейчас ${JSON.stringify(current)}, ожидалось web_app → ${url}.`,
    'Кнопка меню обновляется не мгновенно: проверьте через пару минут.',
    'Кнопка «Открыть SelfCRM» в ответе на /start работает всегда, а кнопку меню в чате бот ставит при первом сообщении.',
  ].join('\n')
}

async function setMenuButton(token, chatId, url) {
  const payload = { menu_button: menuButton(url) }
  if (chatId) payload.chat_id = chatId
  await call('setChatMenuButton', payload, token)
}

// Кнопка меню конкретному человеку: Telegram применяет её сразу, поэтому она ставится при
// первом же сообщении боту — для каждого чата один раз за запуск.
async function ensureChatMenuButton(chat, token, url, done) {
  if (!chat || chat.type !== 'private' || done.has(chat.id)) return
  done.add(chat.id)
  try {
    await setMenuButton(token, chat.id, url)
  } catch (e) {
    console.error(`Кнопка меню в чате не обновилась: ${scrub(e.message)}`)
  }
}

// Команды бота и кнопка меню: после этого Mini App доступен из меню чата.
async function setup(token, url, chats) {
  await call(
    'setMyCommands',
    {
      commands: [
        { command: 'start', description: 'Открыть SelfCRM' },
        { command: 'whatsnew', description: 'Что нового в SelfCRM' },
        { command: 'support', description: 'Поддержать разработку' },
        { command: 'paysupport', description: 'Помощь и возврат по оплате' },
        { command: 'help', description: 'Справка' },
      ],
    },
    token,
  )

  await setMenuButton(token, null, url)
  for (const chatId of chats) {
    await setMenuButton(token, chatId, url)
    console.log(`Кнопка меню задана для чата ${chatId}.`)
  }

  const me = await call('getMe', {}, token)
  console.log(`Готово: @${me.username} → ${url}`)

  const current = await call('getChatMenuButton', {}, token)
  if (current?.type !== 'web_app' || current.web_app?.url !== url) {
    console.log(menuButtonHint(current, url))
  }
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

  // Чаты, которым кнопка меню уже выставлена в этом запуске.
  const menuButtons = new Set()

  let offset = 0
  while (!controller.signal.aborted) {
    let updates
    try {
      updates = await withSignal(
        // pre_checkout_query — подтверждение оплаты звёздами: без него платёж не пройдёт,
        // а сообщение о нём приходит не как message, поэтому запрашиваем оба вида.
        call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'pre_checkout_query'] }, token),
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
        await ensureChatMenuButton(update.message?.chat, token, url, menuButtons)
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

  // Предпросмотр текста «что нового»: ни токена, ни обращения к Telegram — только GitHub.
  if (args.whatsnew) {
    console.log(whatsnewMessage(await latestRelease()))
    return
  }

  // Ссылки на оплату звёздами: их выдаёт Telegram, а живут они в src/utils/support.ts —
  // команда печатает готовый блок, который остаётся вставить в файл.
  if (args.starLinks) {
    const links = await starLinks(resolveToken())
    console.log('Созданы ссылки на счета — вставьте в src/utils/support.ts:')
    console.log('')
    console.log('export const SUPPORT_INVOICE_LINKS: Record<SupportAmount, string> = {')
    for (const amount of SUPPORT_AMOUNTS) console.log(`  ${amount}: '${links[amount]}',`)
    console.log('}')
    return
  }

  const token = resolveToken()
  const url = webAppUrl(args)

  if (args.setup) {
    await setup(token, url, args.chats)
    return
  }

  await runPolling(token, url)
}

main().catch((e) => {
  console.error(scrub(e instanceof Error ? e.message : e))
  process.exitCode = 1
})
