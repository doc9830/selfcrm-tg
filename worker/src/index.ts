// Cloudflare Worker: приём обновлений Telegram через webhook.
//
// Telegram → HTTPS webhook → Worker → Telegram Bot API
//
// Раньше бот получал обновления через long polling (getUpdates) и работал, только пока на
// машине владельца запущен `npm run bot`. Теперь runtime живёт в Cloudflare: компьютер и
// домашний сервер не нужны, отдельных портов открывать не надо.
//
// Роуты:
//   POST /telegram/webhook — обновления Telegram (проверка X-Telegram-Bot-Api-Secret-Token);
//   GET  /                 — проверка, что Worker развёрнут (текст, без секретов).

import { handleUpdate, type TelegramUpdate } from './handler'
import type { Deps, Env } from './telegram'
import { scrub } from './telegram'

export const WEBHOOK_PATH = '/telegram/webhook'

// Секрет сверяется с заголовком, который Telegram присылает при установленном secret_token.
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Проверка развёртывания: удобно открыть в браузере после `wrangler deploy`.
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('SelfCRM bot webhook works\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    if (url.pathname !== WEBHOOK_PATH) {
      return new Response('Not found\n', { status: 404 })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed\n', { status: 405 })
    }

    // Без секрета Worker не настроен: обновления обрабатывать нельзя.
    if (!env.WEBHOOK_SECRET) {
      console.error('Не задан WEBHOOK_SECRET: добавьте секрет Worker и переустановите webhook')
      return new Response('Webhook is not configured\n', { status: 500 })
    }

    if (request.headers.get(SECRET_HEADER) !== env.WEBHOOK_SECRET) {
      // Чужой запрос не обрабатываем и не отвечаем подробностями.
      return new Response('Forbidden\n', { status: 403 })
    }

    let update: TelegramUpdate
    try {
      update = (await request.json()) as TelegramUpdate
    } catch {
      return new Response('Bad request\n', { status: 400 })
    }

    const deps: Deps = { fetch: globalThis.fetch.bind(globalThis) }
    try {
      await handleUpdate(update, env, deps)
    } catch (e) {
      // Ошибку Telegram API записываем в лог, но отвечаем 200: повтор обновления привёл бы
      // к дублям сообщений, а причину (например, недоступность api.telegram.org) видно в логе.
      console.error(`Не удалось обработать обновление: ${scrub(errorText(e), env.BOT_TOKEN)}`)
    }

    return new Response('ok\n')
  },
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
