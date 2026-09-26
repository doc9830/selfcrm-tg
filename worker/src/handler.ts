// Обработка обновлений Telegram: команды, платежи и подсказки.
//
// Логика перенесена из scripts/telegram-bot.mjs без изменений в текстах и порядке ветвей.
// Отличия только те, что нужны Worker: нет процесса (stateless), нет кэша ссылок и релиза,
// а ответ Telegram API уходит сразу — Worker либо ответил, либо записал ошибку в лог.
import { RELEASES_URL, MENU_BUTTON_TEXT } from './config'
import {
  backupMessage,
  fallbackMessage,
  helpMessage,
  keyboard,
  paidMessage,
  paysupportMessage,
  startMessage,
  supportKeyboard,
  supportMessage,
} from './messages'
import { starLinks } from './support'
import type { Deps, Env } from './telegram'
import { telegram, webAppUrl } from './telegram'
import { latestRelease, whatsnewErrorMessage, whatsnewKeyboard, whatsnewMessage } from './whatsnew'

export interface TelegramUser {
  id: number
}

export interface TelegramChat {
  id: number
  type?: string
}

export interface TelegramMessage {
  chat: TelegramChat
  text?: string
  document?: unknown
  successful_payment?: {
    invoice_payload: string
    total_amount: number
    telegram_payment_charge_id: string
  }
}

export interface TelegramUpdate {
  // Номер обновления: нужен только для диагностики — по нему в логе видно, какое именно
  // обновление не удалось обработать.
  update_id?: number
  message?: TelegramMessage
  pre_checkout_query?: {
    id: string
    invoice_payload: string
    total_amount: number
    from?: TelegramUser
  }
}

// Точка входа: одно обновление Telegram → один или несколько вызовов Bot API.
export async function handleUpdate(update: TelegramUpdate, env: Env, deps: Deps): Promise<void> {
  const url = webAppUrl(env)

  // Подтверждение оплаты приходит отдельным обновлением, а не сообщением: ответить на него
  // нужно за 10 секунд, поэтому оно обрабатывается раньше всего остального и без лишних
  // запросов — ни GitHub, ни кнопки меню здесь не трогаются.
  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query
    await telegram(
      'answerPreCheckoutQuery',
      { pre_checkout_query_id: query.id, ok: true },
      env,
      deps,
    )
    console.log(
      `Оплата подтверждена: ${query.invoice_payload}, ${query.total_amount} ⭐ (пользователь ${query.from?.id ?? '—'})`,
    )
    return
  }

  const message = update.message
  if (!message) return

  // Кнопка меню в чате: Telegram применяет её сразу, а общая настройка иногда приходит с
  // задержкой. Раньше это делал процесс бота «один раз за запуск»; у Worker состояния нет,
  // поэтому кнопка ставится на каждое сообщение в личном чате. Ошибка не мешает ответу.
  await ensureChatMenuButton(message.chat, env, deps, url)

  // Успешная оплата — тоже сообщение, но без текста: только поле successful_payment.
  if (message.successful_payment) {
    await onPaid(message, env, deps, url)
    return
  }

  const text = (message.text ?? '').trim()
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase()

  if (command === '/start') {
    await telegram(
      'sendMessage',
      { chat_id: message.chat.id, text: startMessage(), reply_markup: keyboard(url) },
      env,
      deps,
    )
    // Ссылка из плашки поддержки в приложении ведёт сюда: /start support → сразу счёт.
    if (text.split(/\s+/)[1]?.toLowerCase() === 'support') {
      await sendSupport(message.chat.id, env, deps)
    }
    return
  }

  // Поддержка проекта: суммы звёздами кнопками, каждая кнопка — ссылка на счёт.
  if (command === '/support') {
    await sendSupport(message.chat.id, env, deps)
    return
  }

  // Обязательная команда для ботов с цифровыми товарами: помощь и возврат по оплате.
  if (command === '/paysupport') {
    await telegram(
      'sendMessage',
      { chat_id: message.chat.id, text: paysupportMessage(), reply_markup: keyboard(url) },
      env,
      deps,
    )
    return
  }

  if (command === '/help') {
    await telegram(
      'sendMessage',
      { chat_id: message.chat.id, text: helpMessage(url), reply_markup: keyboard(url) },
      env,
      deps,
    )
    return
  }

  // «Что нового»: бот читает последний релиз Android-версии и присылает changelog.
  if (command === '/whatsnew') {
    await sendWhatsnew(message.chat.id, env, deps, url)
    return
  }

  // Присланный файл — резервная копия CRM: отвечаем подсказкой, как её вернуть.
  // Автоматического поиска копий в истории нет: бот не читает переписку и не хранит файлы.
  if (message.document) {
    await telegram(
      'sendMessage',
      { chat_id: message.chat.id, text: backupMessage(), reply_markup: keyboard(url) },
      env,
      deps,
    )
    return
  }

  await telegram(
    'sendMessage',
    { chat_id: message.chat.id, text: fallbackMessage(), reply_markup: keyboard(url) },
    env,
    deps,
  )
}

// Суммы звёздами: сначала ссылки на счета, потом сообщение с кнопками.
async function sendSupport(chatId: number, env: Env, deps: Deps): Promise<void> {
  const links = await starLinks(env, deps)
  await telegram(
    'sendMessage',
    { chat_id: chatId, text: supportMessage(), reply_markup: supportKeyboard(links) },
    env,
    deps,
  )
}

// Полученная оплата: благодарим и пишем в лог charge_id — он нужен для возврата звёзд.
async function onPaid(message: TelegramMessage, env: Env, deps: Deps, url: string): Promise<void> {
  const payment = message.successful_payment
  console.log(
    `Оплата получена: ${payment?.invoice_payload}, ${payment?.total_amount} ⭐, charge ${payment?.telegram_payment_charge_id}`,
  )
  await telegram(
    'sendMessage',
    { chat_id: message.chat.id, text: paidMessage(), reply_markup: keyboard(url) },
    env,
    deps,
  )
}

async function sendWhatsnew(chatId: number, env: Env, deps: Deps, url: string): Promise<void> {
  try {
    const release = await latestRelease(deps)
    await telegram(
      'sendMessage',
      {
        chat_id: chatId,
        text: whatsnewMessage(release),
        reply_markup: whatsnewKeyboard(url, release.html_url || RELEASES_URL),
      },
      env,
      deps,
    )
  } catch (e) {
    // Сеть и лимит запросов GitHub — не повод молчать: даём ссылку на релизы.
    console.error(`Список изменений не получен: ${errorText(e)}`)
    await telegram(
      'sendMessage',
      { chat_id: chatId, text: whatsnewErrorMessage(), reply_markup: keyboard(url) },
      env,
      deps,
    )
  }
}

// Кнопка меню чата: та же кнопка, что ставит общая настройка (npm run bot:setup).
export function menuButton(url: string) {
  return { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url } }
}

async function ensureChatMenuButton(
  chat: TelegramChat,
  env: Env,
  deps: Deps,
  url: string,
): Promise<void> {
  if (!chat || chat.type !== 'private') return
  try {
    await telegram('setChatMenuButton', { chat_id: chat.id, menu_button: menuButton(url) }, env, deps)
  } catch (e) {
    console.error(`Кнопка меню в чате не обновилась: ${errorText(e)}`)
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
