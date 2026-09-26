// Проверки подписи initData: подпись Telegram сходится, чужая — нет.
//
// Главная проверка — на фиксированном векторе: строка initData и её подпись посчитаны
// независимо от кода Worker'а, HMAC-реализацией Node (`node:crypto`, OpenSSL):
//
//   secret = HMAC_SHA256(key="WebAppData", data="123456:TEST-TOKEN")
//   hash   = HMAC_SHA256(key=secret, data="auth_date=1758800000\nquery_id=AAF...\nuser={...}")
//
// Если алгоритм в `webappAuth.ts` разойдётся с документацией Telegram (порядок полей,
// строка проверки, ключ подписи), этот тест упадёт. Остальные случаи строят подпись
// помощником `signedInitData` (worker/src/webappAuthFixture.ts): они проверяют уже разбор
// и срок, а не сам алгоритм.
import { describe, expect, it } from 'vitest'
import { verifyInitData } from './webappAuth'
import {
  signedInitData,
  TEST_AUTH_DATE,
  TEST_BOT_TOKEN,
  TEST_INIT_DATA,
  TEST_NOW,
  TEST_USER_ID,
  userField,
} from './webappAuthFixture'

const BOT_TOKEN = TEST_BOT_TOKEN
const VECTOR_INIT_DATA = TEST_INIT_DATA
const VECTOR_AUTH_DATE = TEST_AUTH_DATE
const VECTOR_USER_ID = TEST_USER_ID
const NOW = TEST_NOW

describe('подпись initData', () => {
  it('принимает вектор, подписанный Telegram (хеш посчитан вне Worker\'а)', async () => {
    const verified = await verifyInitData(VECTOR_INIT_DATA, BOT_TOKEN, { now: NOW })

    expect(verified?.user.id).toBe(VECTOR_USER_ID)
    expect(verified?.user.first_name).toBe('Иван')
    expect(verified?.authDate).toBe(VECTOR_AUTH_DATE)
  })

  it('отказывает, если поле подменили', async () => {
    const tampered = VECTOR_INIT_DATA.replace('auth_date=1758800000', 'auth_date=1758900000')

    expect(await verifyInitData(tampered, BOT_TOKEN, { now: NOW })).toBeNull()
  })

  it('отказывает, если подпись посчитана другим токеном', async () => {
    expect(await verifyInitData(VECTOR_INIT_DATA, '999:ДРУГОЙ-ТОКЕН', { now: NOW })).toBeNull()
  })

  it('принимает тот же набор полей в другом порядке', async () => {
    // Строку проверки Worker собирает сам — сортировкой по имени поля, как Telegram,
    // поэтому порядок в присланной строке на подпись не влияет.
    const reordered = VECTOR_INIT_DATA.split('&').reverse().join('&')
    const verified = await verifyInitData(reordered, BOT_TOKEN, { now: NOW })
    expect(verified?.user.id).toBe(VECTOR_USER_ID)
  })

  it('отказывает, если к подписанным полям добавили чужое', async () => {
    // Подпись покрывает все поля: лишнее поле её ломает.
    const extra = `${VECTOR_INIT_DATA}&start_param=чужое`
    expect(await verifyInitData(extra, BOT_TOKEN, { now: NOW })).toBeNull()
  })
})

describe('срок и состав initData', () => {
  it('принимает свежий initData и отказывает просроченному', async () => {
    const initData = await signedInitData([
      ['auth_date', String(VECTOR_AUTH_DATE)],
      userField(),
    ])

    expect(await verifyInitData(initData, BOT_TOKEN, { now: VECTOR_AUTH_DATE + 60 })).not.toBeNull()
    // Час — предел: минута сверху уже не проходит.
    expect(
      await verifyInitData(initData, BOT_TOKEN, { now: VECTOR_AUTH_DATE + 3661 }),
    ).toBeNull()
  })

  it('отказывает, если пользователя нет или он мусор', async () => {
    const cases: Array<Array<[string, string]>> = [
      // Пользователя нет вовсе.
      [['auth_date', String(VECTOR_AUTH_DATE)]],
      // Пользователь без идентификатора.
      [
        ['auth_date', String(VECTOR_AUTH_DATE)],
        ['user', '{}'],
      ],
      // Пользователь не разбирается.
      [
        ['auth_date', String(VECTOR_AUTH_DATE)],
        ['user', 'не-json'],
      ],
      // Идентификатор дробный: Bot API такого не примет.
      [
        ['auth_date', String(VECTOR_AUTH_DATE)],
        userField(1.5),
      ],
    ]

    for (const fields of cases) {
      const initData = await signedInitData(fields)
      expect(await verifyInitData(initData, BOT_TOKEN, { now: NOW })).toBeNull()
    }
  })

  it('отказывает, если подписи нет или она не хеш', async () => {
    const withoutHash = `auth_date=${VECTOR_AUTH_DATE}&user=%7B%22id%22%3A${VECTOR_USER_ID}%7D`
    expect(await verifyInitData(withoutHash, BOT_TOKEN, { now: NOW })).toBeNull()

    const shortHash = `${withoutHash}&hash=abc`
    expect(await verifyInitData(shortHash, BOT_TOKEN, { now: NOW })).toBeNull()
  })

  it('отказывает, если данных нет вовсе', async () => {
    expect(await verifyInitData(undefined, BOT_TOKEN)).toBeNull()
    expect(await verifyInitData('', BOT_TOKEN)).toBeNull()
    expect(await verifyInitData(VECTOR_INIT_DATA, '')).toBeNull()
  })
})
