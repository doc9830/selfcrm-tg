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
//   POST /files            — временный файл (отчёт из мини-приложения) → ссылка на скачивание;
//   POST /files/<id>/share — «Поделиться»: сообщение с файлом для выбора чата (worker/src/share.ts);
//   GET  /files/<id>       — скачивание временного файла (worker/src/files.ts);
//   GET  /                 — проверка, что Worker развёрнут (текст, без секретов).
//
// Ответ Worker — это подтверждение доставки для Telegram: HTTP 200 означает «обновление
// обработано», и Telegram помечает его доставленным; 5xx означает «не обработано, пришлите
// ещё раз» — Telegram повторит доставку. Поэтому ошибку обработки нельзя глушить: раньше
// Worker отвечал 200 в любом случае, и настоящая ошибка терялась бы вместе с обновлением
// (пользователь не получил ответа, а в `getWebhookInfo` не было бы даже следа).
//
// Повтор обновления безопасен, и вот почему: Worker не хранит состояние, ничего не пишет в
// базу и ничего не выдаёт за платёж — звёзды списывает и зачисляет сам Telegram, а бот лишь
// отвечает сообщением. Все действия бота идемпотентны для Telegram (`setChatMenuButton`) или
// безвредны при повторе (`sendMessage` — то же информационное сообщение, `createInvoiceLink`
// — новая ссылка на тот же счёт, `answerPreCheckoutQuery` — ответ, который Telegram как раз
// повторяет). Дороже всего повтор информационного сообщения, дешевле — потерянная ошибка,
// поэтому 5xx здесь правильнее.

import { WEBHOOK_PATH } from './config'
import { handleFiles } from './files'
import { handleUpdate, type TelegramUpdate } from './handler'
import { handleReportShare } from './share'
import type { Deps, Env } from './telegram'
import { scrub } from './telegram'

// Секрет сверяется с заголовком, который Telegram присылает при установленном secret_token.
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Зависимости, подменяемые в тестах: только сеть. Нужны и файлам («Поделиться»
    // вызывает Bot API), и обновлениям Telegram, поэтому объявлены сразу.
    const deps: Deps = { fetch: globalThis.fetch.bind(globalThis) }

    // «Поделиться» (POST /files/<id>/share) идёт раньше файлов: адрес начинается так же,
    // как у них, а слой файлов на такой запрос отвечает 404. null означает «адрес не наш» —
    // тогда работают файлы и роуты бота ниже.
    const share = await handleReportShare(request, env, deps)
    if (share) return share

    // Временные файлы (отчёт в Excel из мини-приложения): отдельный слой, который
    // ничего не знает про Telegram. null означает «адрес не наш» — тогда работают
    // роуты бота ниже.
    const files = await handleFiles(request, env)
    if (files) return files

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

    try {
      await handleUpdate(update, env, deps)
    } catch (e) {
      // Обработка упала — 200 здесь был бы ложным подтверждением доставки. Отвечаем 500:
      // Telegram повторит обновление (повтор безопасен, см. шапку файла), а причина
      // останется в логе Worker и в `Последняя ошибка доставки` у getWebhookInfo.
      console.error(updateFailureLog(update, e, env))
      return new Response('Processing failed\n', { status: 500 })
    }

    return new Response('ok\n')
  },
}

// Лог упавшего обновления: короткий и структурный, чтобы его было видно в `wrangler tail`.
//
// Тело обновления целиком не пишется — там тексты пользователя и платёжные данные, а для
// диагностики достаточно номера и типа. Из текста ошибки вырезаются оба секрета: и токен
// бота, и секрет webhook (Telegram присылает его в заголовке, но он мог бы попасть в
// сообщение об ошибке).
function updateFailureLog(update: TelegramUpdate, e: unknown, env: Env): string {
  return [
    'Обновление не обработано',
    `update_id=${update?.update_id ?? '—'}`,
    `тип=${updateType(update)}`,
    `ошибка=${scrub(errorText(e), env.BOT_TOKEN, env.WEBHOOK_SECRET)}`,
  ].join('\n')
}

function updateType(update: TelegramUpdate | null | undefined): string {
  if (update?.pre_checkout_query) return 'pre_checkout_query'
  if (update?.message) return 'message'
  return 'unknown'
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
