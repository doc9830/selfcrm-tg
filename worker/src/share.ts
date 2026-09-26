// «Поделиться» отчётом: подготовка сообщения с файлом для меню клиента Telegram.
//
// Кнопка «Поделиться» на экране статистики открывает родное меню клиента — то же, что при
// пересылке сообщения: выбор чата, после которого в чат уходит документ. Открывает меню сам
// клиент (`WebApp.shareMessage`, Bot API 8.0), но сообщение для него заранее собирает бот:
//
//   POST /files/<id>/share → проверить подпись initData, скопировать файл со свежим сроком,
//                            вызвать savePreparedInlineMessage → { preparedMessageId }
//   WebApp.shareMessage(preparedMessageId) → клиент показывает выбор чата
//
// Почему сообщение готовит сервер: `WebApp.shareMessage` принимает только идентификатор
// сообщения, собранного ботом, а в `savePreparedInlineMessage` нужен токен бота. Ничего
// никому не отправляется: пока пользователь сам не выберет чат, сообщения не существует.
// Так же устроен и файл: Telegram скачивает документ по ссылке из подготовленного
// сообщения и уже от себя отдаёт его чату.
//
// Подпись initData — единственная защита этого маршрута: адрес публичный, токена в запросе
// нет. Без проверки чужой человек готовил бы сообщения от имени бота для любых
// пользователей (см. worker/src/webappAuth.ts). Оттуда же берётся `user_id`: сообщение
// получит только тот, кто его попросил.
//
// Копия файла нужна из-за срока: у ссылки из выгрузки он отсчитывается от загрузки, а
// сообщение уходит в чат и должно оставаться живым ещё час. Исходная запись не удаляется —
// на неё мог смотреть пользователь, — и истечёт сама.

import {
  FILES_PATH,
  FILE_TTL_SECONDS,
  json,
  message,
  readStoredFile,
  REPORT_PDF_TYPE,
  storeFile,
} from './files'
import type { Deps, Env } from './telegram'
import { telegram } from './telegram'
import { verifyInitData } from './webappAuth'

// Хвост адреса: `/files/<id>/share`.
const SHARE_SUFFIX = '/share'

// Тело запроса — подпись initData (сотни байт) и подпись сообщения. Больше сюда ничего не
// помещается, поэтому предел маленький: так чужая заливка не съест Worker.
const MAX_BODY_BYTES = 8 * 1024

// Подпись сообщения: первая строка в чате и в карточке файла.
const MAX_CAPTION_LENGTH = 400

// Заголовок карточки в меню выбора чата.
const MAX_TITLE_LENGTH = 80

// Точка входа слоя «Поделиться». null означает «это не адрес отправки» — тогда запрос
// обрабатывают маршруты файлов и бота (см. worker/src/index.ts).
export async function handleReportShare(
  request: Request,
  env: Env,
  deps: Deps,
): Promise<Response | null> {
  const fileId = shareFileId(new URL(request.url).pathname)
  if (fileId === null) return null

  // Предзапрос браузера разбирает слой файлов: заголовки CORS живут там же, и они общие.
  if (request.method === 'OPTIONS') return null
  if (request.method !== 'POST') return message('Method not allowed\n', 405)

  const store = env.REPORT_FILES
  if (!store) {
    console.error('Не задано хранилище REPORT_FILES: добавьте привязку KV (см. wrangler.toml)')
    return json({ error: 'Файлы временно недоступны' }, 503)
  }
  if (!env.BOT_TOKEN) {
    // Без токена сообщение собрать нечем: это настройка Worker'а, а не сбой запроса.
    console.error('Не задан BOT_TOKEN: отправка недоступна (npx wrangler secret put BOT_TOKEN)')
    return json({ error: 'Отправка временно недоступна' }, 503)
  }

  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: 'Запрос слишком большой' }, 413)
  }

  let body: { initData?: unknown; caption?: unknown }
  try {
    body = (await request.json()) as { initData?: unknown; caption?: unknown }
  } catch {
    return json({ error: 'Не читается запрос' }, 400)
  }

  const verified = await verifyInitData(body.initData, env.BOT_TOKEN)
  if (!verified) {
    // Саму подпись и данные пользователя в лог не пишем — только факт отказа: по нему
    // видно, что запрос дошёл и почему не пошёл дальше.
    console.error('Отказ: подпись initData не подтверждена')
    return json({ error: 'Подпись не подтверждена' }, 403)
  }

  const stored = await readStoredFile(store, fileId)
  if (!stored) return json({ error: 'Файл не найден или срок хранения истёк' }, 404)

  const freshId = await storeFile(store, stored)
  const origin = new URL(request.url).origin
  // Имя файла — последним куском адреса: по нему Telegram называет документ, который скачивает
  // для сообщения. Заголовок `Content-Disposition` в ответе тоже есть, но адрес надёжнее: клиент
  // может взять имя из адреса, и тогда файл не придёт безымянным.
  const fileUrl = `${origin}${FILES_PATH}/${freshId}/${encodeURIComponent(stored.name)}`
  const caption = shareCaption(body.caption)

  let prepared: { id?: unknown }
  try {
    prepared = await telegram(
      'savePreparedInlineMessage',
      {
        user_id: verified.user.id,
        result: {
          type: 'document',
          // Идентификатор результата: он же имя нового файла — так в подготовленном
          // сообщении видно, какой файл к нему приложен.
          id: freshId,
          title: shareTitle(stored.name),
          document_url: fileUrl,
          mime_type: shareMimeType(stored.type),
          ...(caption ? { caption } : {}),
        },
        // Куда сообщение можно отправить: личные чаты и группы. Каналы и боты — нет:
        // отчёт личный, а получателя выбирает пользователь.
        allow_user_chats: true,
        allow_group_chats: true,
        allow_bot_chats: false,
        allow_channel_chats: false,
      },
      env,
      deps,
    )
  } catch (e) {
    // Сообщение собрать не вышло — это не ошибка приложения: клиент уйдёт на запасной путь
    // (выбор чата ссылкой `t.me/share/url`). Токен в тексте ошибки вырезан внутри
    // `telegram()` (scrub), поэтому в лог попадает только причина.
    console.error(`savePreparedInlineMessage не сработал: ${e instanceof Error ? e.message : e}`)
    return json({ error: 'Telegram не принял сообщение' }, 502)
  }

  const preparedMessageId = typeof prepared?.id === 'string' ? prepared.id : ''
  if (!preparedMessageId) return json({ error: 'Telegram не вернул сообщение' }, 502)

  // В логе только идентификаторы: ни имени файла, ни содержимого, ни подписи сообщения.
  console.log(
    `Сообщение подготовлено: файл ${fileId} → ${freshId} (пользователь ${verified.user.id})`,
  )
  return json({ preparedMessageId, url: fileUrl, expiresIn: FILE_TTL_SECONDS }, 201)
}

// Идентификатор файла из адреса `/files/<id>/share`. null — адрес не наш: запрос
// обрабатывают маршруты файлов или бота.
function shareFileId(pathname: string): string | null {
  if (!pathname.startsWith(`${FILES_PATH}/`) || !pathname.endsWith(SHARE_SUFFIX)) return null
  const id = pathname.slice(FILES_PATH.length + 1, -SHARE_SUFFIX.length)
  // Идентификатор — одно имя без «/»: иначе сюда попал бы чужой путь.
  return id && !id.includes('/') ? id : null
}

// Тип содержимого для сообщения с файлом. Документ в подготовленном сообщении Telegram принимает
// только двух типов — «application/pdf» или «application/zip» (документация Bot API,
// InlineQueryResultDocument). Это не догадка: вызов `savePreparedInlineMessage` с типом отчёта
// (`…spreadsheetml.sheet`) отвечает «Bad Request: unallowed document MIME type», а с
// `application/zip` — идёт дальше по проверкам. Уловки здесь нет: `.xlsx` — это zip-контейнер,
// байты остаются теми же, имя файла видно и в адресе, и в `Content-Disposition` (`.xlsx`),
// поэтому получатель открывает отчёт в Excel. PDF отдаём как PDF.
export function shareMimeType(type: string): string {
  return type === REPORT_PDF_TYPE ? REPORT_PDF_TYPE : SHARE_ZIP_TYPE
}

// Единственный тип, которым Telegram разрешает отдать не-PDF документ.
const SHARE_ZIP_TYPE = 'application/zip'

// Подпись будущего сообщения. Текст приходит от клиента, поэтому из него убираются
// управляющие символы (переводы строк, табуляция) и ограничивается длина. Пустая подпись —
// сообщение без подписи: так уходит только файл.
function shareCaption(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CAPTION_LENGTH)
}

// Заголовок карточки файла в меню выбора чата: имя файла без расширения, чтобы было видно,
// что именно уходит («SelfCRM_Отчет_2026-09-01_2026-09-26»). Запасное значение — на случай
// пустого имени.
function shareTitle(name: string): string {
  const withoutExtension = name.replace(/\.[a-z0-9]{1,5}$/i, '').trim()
  return withoutExtension.slice(0, MAX_TITLE_LENGTH) || 'Отчёт SelfCRM'
}
