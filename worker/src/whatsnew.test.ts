import { describe, expect, it } from 'vitest'
import { formatDate, markdownToText, truncate, whatsnewMessage } from './whatsnew'

// Тексты «что нового»: бот отправляет сообщения без parse_mode, поэтому markdown из описания
// релиза должен превращаться в читаемый текст (см. scripts/telegram-bot.mjs — та же логика).

describe('markdownToText', () => {
  it('снимает заголовки, списки и подчёркивание', () => {
    const text = markdownToText('## Что нового\n\n- Первое\n* Второе\n> Цитата\n\n---\n')

    expect(text).toBe('Что нового\n• Первое\n• Второе\nЦитата')
  })

  it('убирает звёздочки, кавычки и разворачивает ссылки', () => {
    const text = markdownToText('**Жирный** и `код`\n\n[Релиз](https://example.test/release)')

    expect(text).toBe('Жирный и код\n\nРелиз (https://example.test/release)')
  })

  it('пустая строка остаётся пустой', () => {
    expect(markdownToText(undefined)).toBe('')
  })
})

describe('truncate', () => {
  it('короткий текст не меняется, длинный обрезается многоточием', () => {
    expect(truncate('коротко', 10)).toBe('коротко')
    expect(truncate('a'.repeat(20), 5)).toBe('aaaaa…')
  })
})

describe('formatDate', () => {
  it('дату показывает по-русски, а мусор отдаёт как есть', () => {
    // Точный вид зависит от ICU среды (в Node это «26 сентября 2026 г.»), поэтому
    // проверяем состав: дата по-русски, без английских названий месяца.
    const date = formatDate('2026-09-26T10:00:00Z')
    expect(date).toContain('26 сентября 2026')
    expect(date).not.toMatch(/September/)
    expect(formatDate('не дата')).toBe('не дата')
  })
})

describe('whatsnewMessage', () => {
  it('собирает заголовок, дату и changelog', () => {
    const text = whatsnewMessage({
      tag_name: 'v1.6.0',
      name: 'SelfCRM 1.6.0',
      body: '### Исправления\n\n- Кнопка меню',
      published_at: '2026-09-26T10:00:00Z',
    })

    expect(text).toContain('🚀 Что нового')
    expect(text).toContain('SelfCRM 1.6.0')
    expect(text).toMatch(/Опубликовано: 26 сентября 2026/)
    expect(text).toContain('• Кнопка меню')
    expect(text).toContain('Mini App открывается с GitHub Pages и обновляется сам')
    expect(text).not.toContain('###')
  })

  it('без описания релиза подсказывает, где подробности', () => {
    const text = whatsnewMessage({ tag_name: 'v1.6.1' })

    expect(text).toContain('SelfCRM v1.6.1')
    expect(text).toContain('Описание релиза пустое — подробности на странице релиза.')
  })
})
