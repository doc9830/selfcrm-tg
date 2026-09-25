import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'selfcrm:theme'

// Цвет заголовка браузера (status bar) для каждой темы.
const THEME_COLOR: Record<Theme, string> = {
  light: '#ffffff',
  dark: '#0f172a',
}

function getInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  // Встроенный скрипт в index.html уже поставил тему до отрисовки: он учитывает
  // и сохранённый выбор, и тему Telegram (window.Telegram.WebApp.colorScheme).
  const current = document.documentElement.dataset.theme
  if (current === 'dark' || current === 'light') return current
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Тема, выбранная пользователем вручную (кнопкой в шапке). null — выбора не было,
// значит тему можно брать из окружения: сначала Telegram, затем системную.
function readSavedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'dark' || value === 'light' ? value : null
  } catch {
    return null
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLOR[theme])
  // Цвет иконок статус-бара: светлые на тёмном фоне, тёмные на светлом.
  if (Capacitor.isNativePlatform()) {
    void StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light })
  }
}

interface ThemeContextValue {
  theme: Theme
  toggleTheme: () => void
  // Применить тему Telegram — только пока пользователь не выбрал тему вручную.
  applyTelegramScheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  // Выбор пользователя фиксируется один раз: после нажатия кнопки темы приложение
  // больше не слушает тему Telegram и сохраняет выбор в localStorage.
  const userChoiceRef = useRef(readSavedTheme() !== null)

  useEffect(() => {
    applyTheme(theme)
    if (!userChoiceRef.current) return
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // localStorage может быть недоступен (например, приватный режим) — игнорируем.
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    userChoiceRef.current = true
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  const applyTelegramScheme = useCallback((scheme: Theme) => {
    if (userChoiceRef.current) return
    setTheme(scheme)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggleTheme, applyTelegramScheme }),
    [theme, toggleTheme, applyTelegramScheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme должен использоваться внутри ThemeProvider')
  return ctx
}