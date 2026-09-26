// Тексты и клавиатуры бота. Перенесены один в один из scripts/telegram-bot.mjs:
// формулировки не менялись, чтобы ответы в Telegram остались прежними.
import {
  GITHUB_URL,
  GROUP_URL,
  LANDING_URL,
  MENU_BUTTON_TEXT,
  SUPPORT_AMOUNTS,
  SUPPORT_EMAIL,
  SUPPORT_PAYLOAD,
} from './config'

export interface InlineButton {
  text: string
  url?: string
  web_app?: { url: string }
}

export interface Keyboard {
  inline_keyboard: InlineButton[][]
}

// Клавиатура ответа: запуск Mini App, а под ним — постоянные ссылки проекта.
// Кнопка с web_app работает только в личном чате; ссылки — где угодно.
export function keyboard(url: string): Keyboard {
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

// Тексты бота: обычный SelfCRM, который просто открывается внутри Telegram.
// Ссылки дублируются кнопками (keyboard), поэтому в тексте они не перечисляются.
export function startMessage(): string {
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

export function helpMessage(url: string): string {
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
export function backupMessage(): string {
  return [
    'Файл копии останется в этом чате — его можно скачать в любой момент, в том',
    'числе на другом устройстве.',
    '',
    'Чтобы вернуть данные: SelfCRM → Настройки → Резервная копия →',
    '«Восстановить из файла» и выберите этот файл.',
  ].join('\n')
}

// Ответ на сообщение без команды: подсказка, как открыть приложение.
export function fallbackMessage(): string {
  return 'Нажмите «Открыть SelfCRM» или отправьте /help.'
}

// Текст поддержки: суммы выводятся кнопками — за каждой кнопкой ссылка на счёт.
export function supportMessage(): string {
  return [
    '❤️ Поддержать SelfCRM',
    '',
    'SelfCRM бесплатный и без ограничений. Поддержка помогает проекту жить:',
    'исправлять ошибки, добавлять возможности и держать приложение в порядке.',
    '',
    'Оплата — звёздами Telegram, разово, без подписки. Выберите сумму:',
  ].join('\n')
}

export function supportKeyboard(links: Record<number, string>): Keyboard {
  return {
    inline_keyboard: [
      SUPPORT_AMOUNTS.map((amount) => ({ text: `${amount} ⭐`, url: links[amount] })),
    ],
  }
}

// /paysupport — обязательная команда для ботов, которые продают цифровые товары: по ней
// пользователь должен понять, как получить помощь и возврат.
export function paysupportMessage(): string {
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

// Благодарность за оплату (successful_payment).
export function paidMessage(): string {
  return ['Спасибо! ❤️', '', 'Звёзды пришли — поддержка засчитана. Вопросы по оплате: /paysupport.'].join(
    '\n',
  )
}

// Подпись счёта в поддержке: сумма берётся из кнопки.
export function supportInvoicePayload(amount: number): string {
  return `${SUPPORT_PAYLOAD}-${amount}`
}

export function supportInvoiceDescription(amount: number): string {
  return `Поддержать разработку SelfCRM: ${amount} ⭐`
}
