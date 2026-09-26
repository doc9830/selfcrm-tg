import { describe, expect, it } from 'vitest'
import {
  EMPTY_SUPPORT_STATE,
  SUPPORT_AMOUNTS,
  SUPPORT_COOLDOWN_DAYS,
  SUPPORT_MIN_OPENS,
  parseSupportState,
  serializeSupportState,
  shouldShowSupport,
  supportAmountLabel,
  supportInvoiceUrl,
} from './support'

// Время в тестах фиксируем: отсрочка считается по календарным суткам, и «сегодня»
// не должно зависеть от дня запуска тестов.
const now = new Date('2026-09-26T12:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('shouldShowSupport', () => {
  it('пока приложением почти не пользовались, плашки нет', () => {
    expect(shouldShowSupport(EMPTY_SUPPORT_STATE, 0, now)).toBe(false)
    expect(shouldShowSupport({ ...EMPTY_SUPPORT_STATE, opens: SUPPORT_MIN_OPENS - 1 }, 2, now)).toBe(
      false,
    )
  })

  it('на третьем открытии плашка появляется', () => {
    expect(shouldShowSupport({ ...EMPTY_SUPPORT_STATE, opens: SUPPORT_MIN_OPENS }, 0, now)).toBe(true)
  })

  it('записи в базе заменяют счётчик открытий', () => {
    expect(shouldShowSupport({ ...EMPTY_SUPPORT_STATE, opens: 1 }, 3, now)).toBe(true)
  })

  it('после крестика молчим неделю', () => {
    const base = { ...EMPTY_SUPPORT_STATE, opens: 5, dismissedAt: daysAgo(1) }
    expect(shouldShowSupport(base, 0, now)).toBe(false)
    expect(
      shouldShowSupport({ ...base, dismissedAt: daysAgo(SUPPORT_COOLDOWN_DAYS - 1) }, 0, now),
    ).toBe(false)
    expect(
      shouldShowSupport({ ...base, dismissedAt: daysAgo(SUPPORT_COOLDOWN_DAYS) }, 0, now),
    ).toBe(true)
  })

  it('после поддержки плашку не показываем больше никогда', () => {
    const supported = {
      opens: 9,
      dismissedAt: daysAgo(400),
      supportedAt: daysAgo(1),
    }
    expect(shouldShowSupport(supported, 10, now)).toBe(false)
  })

  it('непонятная дата закрытия отсрочку не создаёт: плашку можно показывать', () => {
    // Такое значение в состояние не попадает (см. parseSupportState), но и здесь важно
    // не «залипнуть» в вечной отсрочке из-за испорченной даты.
    expect(shouldShowSupport({ ...EMPTY_SUPPORT_STATE, opens: 5, dismissedAt: 'вчера' }, 0, now)).toBe(
      true,
    )
  })
})

describe('состояние плашки', () => {
  it('переживает запись и чтение', () => {
    const state = { opens: 4, dismissedAt: '2026-09-20T10:00:00.000Z', supportedAt: null }
    expect(parseSupportState(serializeSupportState(state))).toEqual(state)
  })

  it('мусор в хранилище читается как «ничего не было»', () => {
    expect(parseSupportState(null)).toEqual(EMPTY_SUPPORT_STATE)
    expect(parseSupportState('не json')).toEqual(EMPTY_SUPPORT_STATE)
    expect(parseSupportState('[1, 2]')).toEqual(EMPTY_SUPPORT_STATE)
    expect(parseSupportState('{"opens": "много", "dismissedAt": 42}')).toEqual(EMPTY_SUPPORT_STATE)
    expect(parseSupportState('{"opens": -5}').opens).toBe(0)
  })
})

describe('ссылки на оплату', () => {
  it('каждой сумме соответствует ссылка Telegram', () => {
    for (const amount of SUPPORT_AMOUNTS) {
      expect(supportInvoiceUrl(amount)).toMatch(/^https:\/\/t\.me\/\$/)
    }
  })

  it('для неизвестной суммы ссылки нет', () => {
    expect(supportInvoiceUrl(7)).toBeNull()
  })

  it('подпись суммы — сумма со звездой', () => {
    expect(supportAmountLabel(250)).toBe('250 ⭐')
  })
})
