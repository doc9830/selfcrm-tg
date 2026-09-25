// Мост между SelfCRM и клиентом Telegram.
//
// Компонент ничего не рисует: он сообщает клиенту, что приложение готово, повторяет
// навигацию SelfCRM на системную кнопку «Назад» Telegram, подстраивает цвета клиента
// под выбранную тему и принимает тему из Telegram при первом запуске.
// Вне Telegram все вызовы ничего не делают (см. src/telegram/environment.ts).
import { useEffect, useRef } from 'react'
import { useRoute } from '../router'
import { useTheme } from '../state/ThemeContext'
import { BACK_EVENT, backTarget } from '../utils/back'
import {
  initTelegramEnvironment,
  onTelegramBackButton,
  onTelegramThemeChange,
  setTelegramBackButtonVisible,
  syncTelegramChrome,
  telegramColorScheme,
} from '../telegram/environment'
import { getTelegramWebApp } from '../telegram/webapp'

export function TelegramShell() {
  const { route, navigate } = useRoute()
  const { theme, applyTelegramScheme } = useTheme()
  const app = getTelegramWebApp()

  // Адрес и переход берём из refs: слушатели Telegram создаются один раз и не должны
  // пересоздаваться на каждом переходе (как в components/SystemBack.tsx).
  const routeRef = useRef(route)
  const navigateRef = useRef(navigate)
  useEffect(() => {
    routeRef.current = route
    navigateRef.current = navigate
  })

  // Готовность и полноэкранный режим + слежение за размерами окна Telegram.
  useEffect(() => initTelegramEnvironment(), [])

  // Тема SelfCRM → цвета клиента Telegram (шапка и фон вокруг Mini App).
  useEffect(() => {
    syncTelegramChrome(theme)
  }, [theme])

  // Тема Telegram → SelfCRM. Работает, пока пользователь не выбрал тему вручную.
  useEffect(() => {
    const apply = () => {
      const scheme = telegramColorScheme()
      if (scheme) applyTelegramScheme(scheme)
    }
    const unsubscribe = onTelegramThemeChange(apply)
    apply()
    return unsubscribe
  }, [applyTelegramScheme])

  // Системная кнопка «Назад»: сначала закрывает открытые окна (как на Android),
  // затем повторяет переход стрелочки в шапке, а на «Главной» закрывает Mini App.
  useEffect(() => {
    return onTelegramBackButton(() => {
      if (!document.dispatchEvent(new CustomEvent(BACK_EVENT, { cancelable: true }))) return
      const target = backTarget(routeRef.current)
      if (target) navigateRef.current(target)
      else app?.close()
    })
  }, [app])

  // Кнопка показывается только там, где в SelfCRM есть куда вернуться:
  // на верхнем уровне разделов выход из Mini App делает сам Telegram.
  useEffect(() => {
    setTelegramBackButtonVisible(Boolean(backTarget(route)))
  }, [route])

  return null
}
