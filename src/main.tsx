import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { DataProvider } from './state/DataContext'
import { SortProvider } from './state/SortContext'
import { ThemeProvider } from './state/ThemeContext'
import { registerTelegramReportFiles } from './telegram/files'
import './index.css'

// Мост выгрузки отчёта: внутри клиента Telegram готовый `.xlsx` отдаётся временной
// ссылкой (файл со страницы там не сохраняется). Регистрация до первой отрисовки:
// экран статистики спрашивает мост в момент нажатия, а не в момент импорта. Вне
// Telegram мост не ставится — приложение работает как обычная веб-версия.
registerTelegramReportFiles()

// Офлайн-режим: после первой загрузки оболочка приложения лежит в кэше браузера
// (public/sw.js), поэтому Mini App открывается и при недоступном GitHub Pages.
// В dev-режиме service worker не нужен и мешал бы горячей перезагрузке.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Без service worker приложение просто работает как обычный сайт.
    })
  })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <DataProvider>
        <SortProvider>
          <App />
        </SortProvider>
      </DataProvider>
    </ThemeProvider>
  </React.StrictMode>,
)

