// Единая версия приложения — используется на экране настроек и при проверке обновлений.
// При выпуске новой версии Android-сборки обновите это значение командой `npm run bump -- <версия>`:
// номер Mini App ведут вместе с релизом Android-версии. Релизы в этой копии не публикуются
// (см. docs/UPSTREAM_SYNC.md), поэтому релиза с совпадающим тегом здесь не появляется.
export const APP_VERSION = '1.8.4'

// Репозиторий, из которого приложение проверяет обновления (только Android-сборка:
// веб-версия и Mini App всегда открываются с последней версией с GitHub Pages).
export const GITHUB_REPO = 'doc9830/selfcrm-tg'
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`
