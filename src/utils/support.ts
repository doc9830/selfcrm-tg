// Плашка «Поддержите разработку»: когда её показывать, что в ней написано и по каким
// ссылкам идёт оплата.
//
// Правила показа (решение владельца проекта):
//   * поддержал — плашка больше не появляется никогда;
//   * закрыл крестиком — молчим SUPPORT_COOLDOWN_DAYS дней, потом можно показать снова;
//   * пока приложением почти не пользовались (меньше SUPPORT_MIN_OPENS открытий и меньше
//     SUPPORT_MIN_RECORDS записей) — не показываем: иначе это выглядит как реклама, а не
//     как «если SelfCRM пригодился — можно поддержать проект».
//
// Само состояние (сколько раз открывали, когда закрыли, когда поддержали) живёт в
// db/supportState.ts: в Telegram — в облаке Telegram, вне его — в localStorage. Здесь
// только расчёт и тексты, поэтому модуль чистый и его удобно тестировать.

// Сколько звёзд предлагаем. Первая сумма — «спасибо за кофе», последняя — заметная.
export const SUPPORT_AMOUNTS = [50, 100, 250, 500] as const

export type SupportAmount = (typeof SUPPORT_AMOUNTS)[number]

// Сколько раз открыть приложение, прежде чем вообще заводить разговор о поддержке.
export const SUPPORT_MIN_OPENS = 3

// Либо столько записей в базе: если человек уже работает в SelfCRM, ждать открытий незачем.
export const SUPPORT_MIN_RECORDS = 3

// Сколько дней молчать после закрытия плашки.
export const SUPPORT_COOLDOWN_DAYS = 7

// Ссылки на оплату звёздами Telegram по суммам. Их выдаёт Telegram по запросу бота:
//
//   npm run bot -- --star-links
//
// Ссылка постоянная: открывать её можно многократно, и каждый платёж приходит боту
// отдельным сообщением successful_payment. Оплату подтверждает бот (pre_checkout_query),
// поэтому ссылки работают, пока запущен процесс бота.
export const SUPPORT_INVOICE_LINKS: Record<SupportAmount, string> = {
  50: 'https://t.me/$rnBbxOB9uUk9EwAAKcrNY5hAAxE',
  100: 'https://t.me/$BjbzlOB9uUk-EwAAW8JzSydn6K4',
  250: 'https://t.me/$BL0PyOB9uUk_EwAARldm1CeBpZQ',
  500: 'https://t.me/$YDhJPeB9uUlAEwAANuE0-zIMizo',
}

// Ссылка на оплату выбранной суммы. null — ссылки для такой суммы нет (интерфейс тогда
// предлагает бота: /support в чате присылает те же счета).
export function supportInvoiceUrl(amount: number): string | null {
  const link = SUPPORT_INVOICE_LINKS[amount as SupportAmount]
  return link || null
}

// Состояние плашки. Всё, что запоминается между запусками.
export interface SupportState {
  // Сколько раз открывали приложение (считается раз за открытие главного экрана).
  opens: number
  // Когда закрыли плашку крестиком (ISO-время) — от этой даты идёт отсрочка.
  dismissedAt: string | null
  // Когда поддержали — после этого плашка не показывается никогда.
  supportedAt: string | null
}

export const EMPTY_SUPPORT_STATE: SupportState = { opens: 0, dismissedAt: null, supportedAt: null }

// Разбор состояния из хранилища. Мусор и чужие значения читаются как «ничего не было»:
// показать плашку лишний раз не страшно, а сломать приложение из-за состояния — нельзя.
export function parseSupportState(raw: string | null | undefined): SupportState {
  if (!raw) return { ...EMPTY_SUPPORT_STATE }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ...EMPTY_SUPPORT_STATE }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_SUPPORT_STATE }
  }

  const file = value as Record<string, unknown>
  const opens = typeof file.opens === 'number' && Number.isFinite(file.opens) ? file.opens : 0
  return {
    opens: Math.max(0, Math.floor(opens)),
    dismissedAt: isoOrNull(file.dismissedAt),
    supportedAt: isoOrNull(file.supportedAt),
  }
}

export function serializeSupportState(state: SupportState): string {
  return JSON.stringify({
    opens: state.opens,
    dismissedAt: state.dismissedAt,
    supportedAt: state.supportedAt,
  })
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  return Number.isNaN(new Date(value).getTime()) ? null : value
}

// Прошла ли отсрочка после закрытия: считаем по календарным суткам от даты закрытия.
export function supportCooldownPassed(dismissedAt: string | null, now: Date): boolean {
  if (!dismissedAt) return true
  const dismissed = new Date(dismissedAt).getTime()
  if (Number.isNaN(dismissed)) return true
  return now.getTime() - dismissed >= SUPPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
}

// Показывать ли плашку сейчас. `records` — сколько записей уже есть в CRM
// (клиенты, заказы и товары вместе), `now` — текущее время (в тестах подставляется).
export function shouldShowSupport(state: SupportState, records: number, now: Date = new Date()): boolean {
  if (state.supportedAt) return false
  if (state.opens < SUPPORT_MIN_OPENS && records < SUPPORT_MIN_RECORDS) return false
  return supportCooldownPassed(state.dismissedAt, now)
}

// Тексты плашки. Короткие: плашка занимает небольшую полосу внизу главного экрана.
export const SUPPORT_TITLE = '❤️ Нравится SelfCRM?'
export const SUPPORT_TEXT = 'Поддержите разработку ⭐'
export const SUPPORT_DETAIL =
  'Оплата звёздами Telegram: это разовая поддержка проекта, а не подписка. Приложение остаётся бесплатным и без ограничений.'
export const SUPPORT_THANKS = 'Спасибо! Ваша поддержка помогает развивать SelfCRM ❤️'
export const SUPPORT_FAILED = 'Оплата не прошла. Попробуйте ещё раз или напишите нам.'

// Подпись суммы: «50 ⭐».
export function supportAmountLabel(amount: number): string {
  return `${amount} ⭐`
}
