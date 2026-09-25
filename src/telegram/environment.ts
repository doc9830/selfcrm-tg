// Окружение Telegram: полноэкранный режим, размеры окна, цвета «рамки» клиента.
//
// Все функции безопасны вне Telegram: если window.Telegram.WebApp нет, они ничего
// не делают, а CRM продолжает работать как обычное браузерное приложение.

import { getTelegramWebApp, type TelegramWebApp } from './webapp'

export type ColorScheme = 'light' | 'dark'

// Цвета, которыми Telegram закрашивает свою шапку и фон вокруг Mini App,
// подобранные под палитру тем SelfCRM (src/state/ThemeContext.tsx).
const CHROME_COLOR: Record<ColorScheme, string> = {
  light: '#ffffff',
  dark: '#0f172a',
}

// Сообщает клиенту Telegram, что приложение готово, разворачивает Mini App на весь
// экран и следит за изменением размеров окна. Возвращает функцию очистки.
export function initTelegramEnvironment(): () => void {
  const app = getTelegramWebApp()
  if (!app) return () => {}

  try {
    app.ready()
    app.expand()
  } catch {
    // Старые версии клиента могут не знать часть методов — работаем без них.
  }

  applyViewport(app)
  const onViewport = () => applyViewport(app)
  app.onEvent('viewportChanged', onViewport)

  return () => app.offEvent('viewportChanged', onViewport)
}

// Высоту Mini App Telegram отдаёт сам: в CSS она используется как --tg-stable-height
// (см. src/index.css), чтобы нижняя навигация не уезжала под системные жесты.
function applyViewport(app: TelegramWebApp): void {
  const root = document.documentElement
  if (app.viewportStableHeight > 0) {
    root.style.setProperty('--tg-stable-height', `${app.viewportStableHeight}px`)
  }
  if (app.viewportHeight > 0) {
    root.style.setProperty('--tg-height', `${app.viewportHeight}px`)
  }
}

// Тема SelfCRM → цвета клиента Telegram (шапка и фон за пределами Mini App).
export function syncTelegramChrome(scheme: ColorScheme): void {
  const app = getTelegramWebApp()
  if (!app) return
  const color = CHROME_COLOR[scheme]
  try {
    app.setHeaderColor?.(color)
    app.setBackgroundColor?.(color)
  } catch {
    // Клиент без поддержки setHeaderColor — тема клиента останется прежней.
  }
}

// Тема оформления, которую выбрал пользователь в самом Telegram (или null вне Telegram).
export function telegramColorScheme(): ColorScheme | null {
  const scheme = getTelegramWebApp()?.colorScheme
  return scheme === 'dark' || scheme === 'light' ? scheme : null
}

// Кнопка «Назад» Telegram: показываем только там, где в SelfCRM есть куда вернуться.
export function setTelegramBackButtonVisible(visible: boolean): void {
  const button = getTelegramWebApp()?.BackButton
  if (!button) return
  try {
    if (visible) button.show()
    else button.hide()
  } catch {
    // Кнопка недоступна в этой версии клиента — навигация остаётся в шапке приложения.
  }
}

// Подписка на нажатие кнопки «Назад» и на смену темы Telegram.
// Возвращает функцию отписки.
export function onTelegramBackButton(handler: () => void): () => void {
  const button = getTelegramWebApp()?.BackButton
  if (!button) return () => {}
  button.onClick(handler)
  return () => button.offClick(handler)
}

export function onTelegramThemeChange(handler: () => void): () => void {
  const app = getTelegramWebApp()
  if (!app) return () => {}
  app.onEvent('themeChanged', handler)
  return () => app.offEvent('themeChanged', handler)
}
