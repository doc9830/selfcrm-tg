// Постоянные значения бота: адреса проекта и параметры поддержки звёздами.
//
// Значения перенесены один в один из локального бот-лаунчера (scripts/telegram-bot.mjs),
// чтобы текст ответов не изменился. Суммы совпадают с SUPPORT_AMOUNTS в
// src/utils/support.ts — там же лежат ссылки на счета, которые открывает Mini App.

// Постоянные ссылки проекта: бот добавляет их кнопками к каждому ответу (см. keyboard),
// а в /help перечисляет текстом — исходный код, лендинг и группа SelfCRM для вопросов.
export const GITHUB_URL = 'https://github.com/doc9830/SelfCRM'
export const LANDING_URL = 'https://doc9830.github.io/SelfCRMlanding/'
export const GROUP_URL = 'https://t.me/selfcrmtg'

// Релизы Android-версии: публичный API, токен не нужен. Список изменений живёт там,
// а Mini App обновляется сам с GitHub Pages — /whatsnew только рассказывает, что нового.
export const RELEASES_API = 'https://api.github.com/repos/doc9830/SelfCRM/releases'
export const RELEASES_URL = 'https://github.com/doc9830/SelfCRM/releases'
export const GITHUB_USER_AGENT = 'selfcrm-telegram-bot'

// Адрес Mini App по умолчанию: подставляется, если в переменных Worker нет WEBAPP_URL.
export const DEFAULT_WEBAPP_URL = 'https://doc9830.github.io/selfcrm-tg/'

export const MENU_BUTTON_TEXT = 'Открыть SelfCRM'

// Поддержка проекта: суммы в звёздах Telegram.
export const SUPPORT_AMOUNTS = [50, 100, 250, 500]

// Что за товар продаём: так подписаны счёт и платёжный лист.
export const SUPPORT_TITLE = 'Поддержка SelfCRM'
export const SUPPORT_DESCRIPTION = 'Поддержать разработку SelfCRM'

// Одна и та же строка payload у всех счетов: по ней видно, что платёж — поддержка.
export const SUPPORT_PAYLOAD = 'selfcrm-support'

// Адрес для вопросов по оплате (команда /paysupport).
export const SUPPORT_EMAIL = 'doc9830@proton.me'

// Путь webhook: Telegram присылает обновления сюда, тот же путь ставит
// `scripts/set-webhook.mjs`. Константа живёт отдельно от входа Worker не случайно: файл
// `worker/src/index.ts` — это точка входа, и по правилам Cloudflare из него экспортируется
// только обработчик (`export default`). Любой лишний именованный экспорт из entry-файла
// ломает запуск: `wrangler dev` падает с «Incorrect type for map entry ...».
export const WEBHOOK_PATH = '/telegram/webhook'
