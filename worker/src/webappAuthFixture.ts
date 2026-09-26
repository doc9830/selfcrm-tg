// Данные для проверок подписи initData: ими пользуются оба теста — и самой проверки
// (worker/src/webappAuth.test.ts), и маршрута «Поделиться» (worker/src/share.test.ts).
//
// Здесь только вычисление подписи тем же алгоритмом, что у Telegram (`secret_key` из токена
// и `data_check_string` из полей) — тестам нужно собрать входные данные, которые сервер
// примет. Правильность самого алгоритма доказывает не этот помощник, а вектор
// TEST_INIT_DATA: он посчитан независимо, HMAC-реализацией Node (OpenSSL).

export const TEST_BOT_TOKEN = '123456:TEST-TOKEN'

// Время выпуска подписи в векторе и «сейчас» рядом с ним: минута после выпуска.
export const TEST_AUTH_DATE = 1758800000
export const TEST_NOW = TEST_AUTH_DATE + 60
export const TEST_USER_ID = 123456789

// Строка от клиента Telegram и подпись, которая к ней подходит:
//   secret = HMAC_SHA256(key="WebAppData", data=TEST_BOT_TOKEN)
//   hash   = HMAC_SHA256(key=secret, data="auth_date=…\nquery_id=…\nuser=…")
export const TEST_INIT_DATA =
  'auth_date=1758800000&query_id=AAFdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A123456789%2C%22first_name%22%3A%22%D0%98%D0%B2%D0%B0%D0%BD%22%2C%22username%22%3A%22ivan%22%7D&hash=92dca427b4bf85965253a675b5b7051deb115bfc2aa4a21cd18d8a76bc7178a7'

// Подпись набора полей: строка проверки собирается сортировкой по имени поля — так же,
// как её собирает и проверяет сервер.
export async function signedInitData(
  fields: Array<[string, string]>,
  token = TEST_BOT_TOKEN,
): Promise<string> {
  const checkString = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const secret = await hmac(bytes('WebAppData'), token)
  const params = new URLSearchParams(fields)
  params.set('hash', hex(await hmac(secret, checkString)))
  return params.toString()
}

// Пользователь для initData: идентификатор уходит в Bot API как `user_id`.
export function userField(id: number = TEST_USER_ID): [string, string] {
  return ['user', JSON.stringify({ id, first_name: 'Иван', username: 'ivan' })]
}

// Подпись с сегодняшним `auth_date`: так сервер не откажет по сроку в тестах маршрута.
export async function freshInitData(now: number = Math.floor(Date.now() / 1000)): Promise<string> {
  return await signedInitData([['auth_date', String(now)], userField()])
}

async function hmac(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return await crypto.subtle.sign({ name: 'HMAC' }, cryptoKey, new TextEncoder().encode(message))
}

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
