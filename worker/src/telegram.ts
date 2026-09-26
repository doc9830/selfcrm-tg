// Транспорт Telegram Bot API в Cloudflare Worker.
//
// В Worker нет Node.js: только Web API (fetch, Request, Response, URL). Токен приходит
// в env из Cloudflare Secret и никогда не попадает ни в ответ, ни в лог — все сообщения
// об ошибках проходят через scrub().

// Секреты приходят из Cloudflare: BOT_TOKEN и WEBHOOK_SECRET — через `wrangler secret put`,
// WEBAPP_URL — обычная переменная из wrangler.toml (см. раздел «Cloudflare» в README).
export interface Env {
  BOT_TOKEN: string
  WEBHOOK_SECRET: string
  WEBAPP_URL?: string
}

// Зависимости, подменяемые в тестах: только сеть. Никакого другого окружения у Worker нет,
// поэтому unit-тесту достаточно подставить свой fetch.
export interface Deps {
  fetch: typeof fetch
}

const TELEGRAM_API = 'https://api.telegram.org'

const DEFAULT_WEBAPP_URL = 'https://doc9830.github.io/selfcrm-tg/'

export function webAppUrl(env: Env): string {
  return env.WEBAPP_URL || DEFAULT_WEBAPP_URL
}

// Токен не должен попадать в логи, даже в тексте ошибок Telegram.
export function scrub(text: unknown, token: string): string {
  const value = String(text)
  return token ? value.split(token).join('***') : value
}

// Вызов метода Bot API: POST с JSON, проверка response.ok и json.ok, понятная ошибка.
// Токен в тексте ошибки заменяется на *** (scrub).
export async function telegram(
  method: string,
  payload: Record<string, unknown>,
  env: Env,
  deps: Deps,
): Promise<any> {
  if (!env.BOT_TOKEN) {
    throw new Error('Не задан BOT_TOKEN: добавьте секрет Worker (npx wrangler secret put BOT_TOKEN)')
  }

  const response = await deps.fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })

  const json: any = await response.json().catch(() => null)
  if (!json || !json.ok) {
    const description = json?.description
      ? scrub(json.description, env.BOT_TOKEN)
      : `HTTP ${response.status}`
    throw new Error(`${method}: ${description}`)
  }
  return json.result
}
