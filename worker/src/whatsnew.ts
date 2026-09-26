// «Что нового»: changelog последнего релиза Android-версии.
//
// Источник — публичный GitHub API, токен не нужен. Кэша нет: Worker не хранит состояние
// между запросами (long polling удалён, обновления принимает webhook), а /whatsnew вызывают
// руками редко. Если GitHub недоступен или сработал лимит запросов, бот присылает ссылку на
// релизы — то же поведение, что было у локального лаунчера.
import { GITHUB_USER_AGENT, MENU_BUTTON_TEXT, RELEASES_API, RELEASES_URL } from './config'
import type { Deps } from './telegram'
import type { Keyboard } from './messages'

export interface Release {
  tag_name: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
}

// Последний опубликованный релиз Android-версии. Черновики и пререлизы GitHub в /latest
// не отдаёт, поэтому в ответе всегда то, что реально вышло. Ошибка — на совести вызывающего.
export async function latestRelease(deps: Deps): Promise<Release> {
  const response = await deps.fetch(`${RELEASES_API}/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': GITHUB_USER_AGENT },
  })
  if (!response.ok) throw new Error(`GitHub releases: HTTP ${response.status}`)
  const release: Release = await response.json()
  if (!release?.tag_name) throw new Error('GitHub releases: пустой ответ')
  return release
}

// Описание релиза — markdown, а бот отправляет сообщения без parse_mode. Разметку снимаем:
// заголовки и списки остаются читаемыми, а **звёздочки** и `кавычки` в чат не попадают.
export function markdownToText(markdown: string | undefined): string {
  return String(markdown ?? '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Лимит сообщения Telegram — 4096 символов; оставляем запас на заголовок и подписи.
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

// «Что нового»: changelog последнего релиза. Отдельно проговаривается главное для Mini App —
// он берётся с GitHub Pages и обновляется сам, поэтому обновлять вручную нечего.
export function whatsnewMessage(release: Release): string {
  const lines = ['🚀 Что нового', '', release.name || `SelfCRM ${release.tag_name}`]
  if (release.published_at) lines.push(`Опубликовано: ${formatDate(release.published_at)}`)
  lines.push(
    '',
    truncate(markdownToText(release.body), 3200) ||
      'Описание релиза пустое — подробности на странице релиза.',
    '',
  )
  lines.push(
    'Mini App открывается с GitHub Pages и обновляется сам: новая версия уже внутри —',
    'обновлять или переустанавливать ничего не нужно.',
  )
  return lines.join('\n')
}

export function whatsnewKeyboard(url: string, releaseUrl: string): Keyboard {
  return {
    inline_keyboard: [
      [{ text: MENU_BUTTON_TEXT, web_app: { url } }],
      [{ text: 'Релиз на GitHub', url: releaseUrl }],
    ],
  }
}

// Сообщение на случай, когда GitHub не ответил: молчать нельзя, даём ссылку на релизы.
export function whatsnewErrorMessage(): string {
  return ['Список изменений не удалось получить с GitHub.', `Страница релизов: ${RELEASES_URL}`].join(
    '\n',
  )
}
