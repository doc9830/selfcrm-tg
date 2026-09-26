// Проверка подписи `initData`: данные мини-приложения подтверждает сам Telegram.
//
// Нужна там, где приложение просит Worker сделать что-то от имени пользователя — сейчас это
// подготовка сообщения «Поделиться» (worker/src/share.ts). На клиенте подпись проверить
// нечем: ключ подписи — токен бота, а его в браузере нет. Схема из документации Telegram
// (Mini Apps → «Validating data received via the Mini App»):
//
//   secret_key = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)
//   hash       = HMAC_SHA256(key=secret_key,  data=data_check_string)   (hex)
//
// где `data_check_string` — пары `ключ=значение` из initData, кроме `hash`, отсортированные
// по имени поля и склеенные переводом строки. Значения берутся из тех же байтов, что пришли
// от клиента (без декодирования): иначе подпись не сойдётся.
//
// Свежесть проверяется вместе с подписью: подпись без срока — это вход навсегда, а клиент
// выдаёт initData один раз при открытии мини-приложения.
//
// Модуль чистый: только Web Crypto (`crypto.subtle`), который есть и в Worker, и в Node, —
// поэтому алгоритм проверяется тестами (worker/src/webappAuth.test.ts).

const HASH_PATTERN = /^[0-9a-f]{64}$/

// Ключ подписи initData по документации Telegram: он один для всех ботов.
const WEBAPP_DATA_KEY = 'WebAppData'

const ALGORITHM = 'HMAC'
const HASH = 'SHA-256'

// Насколько «свежим» должен быть initData. Клиент выдаёт его при открытии мини-приложения,
// а не на каждый запрос, поэтому запас — час: за это время чужую подпись не подставить
// повторно, а пользователь не увидит «откройте приложение заново» на первом же нажатии.
const DEFAULT_MAX_AGE_SECONDS = 60 * 60

// Пользователь из initData: для «Поделиться» нужен только идентификатор — по нему Bot API
// готовит сообщение.
export interface WebAppUser {
  id: number
  first_name?: string
  username?: string
}

export interface VerifiedInitData {
  user: WebAppUser
  authDate: number
}

export interface VerifyInitDataOptions {
  // Текущее время в секундах — подставляется тестом, чтобы проверка срока была устойчивой.
  now?: number
  maxAgeSeconds?: number
}

// null — «данным верить нельзя»: подписи нет, она не сходится, срок вышел или вместо
// пользователя мусор. Одна причина отказа на все случаи: вызывающему (worker/src/share.ts)
// важно только «можно или нельзя», а подробности чужому человеку знать незачем.
export async function verifyInitData(
  initData: unknown,
  botToken: string,
  options: VerifyInitDataOptions = {},
): Promise<VerifiedInitData | null> {
  if (typeof initData !== 'string' || !initData || !botToken) return null

  const params = new URLSearchParams(initData)
  const hash = (params.get('hash') ?? '').toLowerCase()
  if (!HASH_PATTERN.test(hash)) return null

  const secret = await hmac(new TextEncoder().encode(WEBAPP_DATA_KEY), botToken)
  const expected = hex(await hmac(secret, dataCheckString(params)))
  if (!equalHex(expected, hash)) return null

  const authDate = Number(params.get('auth_date') ?? '')
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(authDate) || authDate <= 0 || now - authDate > maxAge) return null

  const user = parseUser(params.get('user'))
  if (!user) return null

  return { user, authDate }
}

// Пары `ключ=значение` из initData, кроме `hash`: отсортированы по имени поля и склеены
// переводом строки — ровно так строку проверки собирает Telegram. Сортировка именно по
// ключу, а не по целой паре: «key=a» и «key2=b» при сравнении строк встают иначе.
function dataCheckString(params: URLSearchParams): string {
  const entries = [...params.entries()].filter(([key]) => key !== 'hash')
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.map(([key, value]) => `${key}=${value}`).join('\n')
}

// HMAC-SHA256: ключ и сообщение — байты, результат — байты.
async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    // Копия в свежий ArrayBuffer, а не сам `Uint8Array`: Web Crypto принимает
    // `BufferSource`, а тип значения из `Uint8Array` в новых TypeScript шире
    // (`ArrayBufferLike` — включая разделяемую память).
    copyBuffer(key),
    { name: ALGORITHM, hash: HASH },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: ALGORITHM },
    cryptoKey,
    new TextEncoder().encode(message),
  )
  return new Uint8Array(signature)
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function hex(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

// Сравнение подписей без раннего выхода: по времени ответа нельзя узнать, сколько символов
// хеша угадано.
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Пользователь из initData. Идентификатор — целое положительное число: он уходит в Bot API
// как `user_id`, и дробное значение там не примут.
function parseUser(raw: string | null): WebAppUser | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WebAppUser>
    const id = Number(parsed?.id)
    if (!Number.isSafeInteger(id) || id <= 0) return null
    return {
      id,
      first_name: typeof parsed?.first_name === 'string' ? parsed.first_name : undefined,
      username: typeof parsed?.username === 'string' ? parsed.username : undefined,
    }
  } catch {
    // Мусор вместо пользователя: подписи в этом случае верить всё равно нельзя — считаем,
    // что пользователя нет.
    return null
  }
}
