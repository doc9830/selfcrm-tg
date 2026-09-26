# Синхронизация фич из doc9830/SelfCRM

Этот репозиторий (`doc9830/selfcrm-tg`) — копия Android-проекта `doc9830/SelfCRM`,
адаптированная под Telegram Mini App по отдельному техзаданию (в репозиторий оно не входит
и хранится локально). Новые функции появляются в Android-репозитории, и их нужно переносить
сюда. Документ фиксирует, насколько копии разошлись (замер 26.09.2026: обе версии — 1.7.0),
правило минимальной дивергенции и три способа переносить изменения дальше.

## Статус

Реализовано (способ A + `/whatsnew`):

| Что | Где |
| --- | --- |
| Скрипт переноса: план, перенос, отчёт | `scripts/sync-from-selfcrm.mjs` |
| Состояние: до какого коммита upstream синхронизировано | `.sync-state.json` |
| Автозапуск (по расписанию и вручную), проверки, ветка и PR | `.github/workflows/sync-from-selfcrm.yml` |
| Проверки на любые pull request | `.github/workflows/ci.yml` |
| Команда `/whatsnew` в боте (changelog релиза) | `worker/src/whatsnew.ts` и тексты в `worker/src/messages.ts` (предпросмотр без отправки: `npm run bot -- --whatsnew`) |

Как пользоваться:

```bash
# 1. Проверить план переноса руками (ничего не меняется)
git clone https://github.com/doc9830/SelfCRM.git /tmp/selfcrm-upstream
node scripts/sync-from-selfcrm.mjs --upstream /tmp/selfcrm-upstream

# 2. Или запустить workflow: Actions → Sync from SelfCRM → Run workflow
#    (он сам открывает PR с отчётом; отдельный CI на такой PR не сработает,
#     поэтому typecheck, тесты и сборка идут внутри workflow до публикации ветки)

# 3. Посмотреть, что расскажет бот про последнюю версию
npm run bot -- --whatsnew
```

Из настроек репозитория нужна одна: **Allow GitHub Actions to create and approve pull requests**
(Settings → Actions → General → Workflow permissions) — она уже включена. Если её выключить,
workflow не упадёт: ветка синхронизации всё равно отправится, а ссылка на создание PR появится
в сводке запуска. CI на таком PR GitHub может пометить как `action_required` (нужно подтверждение
запуска) — поэтому типы, тесты и сборка выполняются внутри самой синхронизации, до публикации ветки.

## 1. Замер: что совпадает, а что нет

| | |
| --- | --- |
| Android-версия | `doc9830/SelfCRM`, ветка `main`, тег `v1.7.0` | 
| Mini App | `doc9830/selfcrm-tg`, ветка `main` |
| `src/**` | 78 файлов в upstream, 102 здесь: 59 совпадает, 19 с локальной адаптацией, 24 только здесь |
| Совпадает вне `src/` | 46 файлов: `public/mailto.html`, `vite.config.ts`, `tsconfig.json`, `capacitor.config.ts`, `package-lock.json`, `LICENSE`, `release-assets/**` (по `v1.5.0` включительно), `scripts/bump-version.mjs`, `scripts/telegram-release.mjs`, `scripts/fixtures/*`, `scripts/shots/*` (съёмка скриншотов: клиент DevTools, демо-база, оптимизация кадров), `android/**` кроме ассетов значка |
| Только здесь вне `src/` | `public/route.html` — страница-мост для маршрута (в Android-версии системный выбор навигатора даёт `geo:`-intent Capacitor, а мини-приложению нужна страница в браузере клиента); `public/sw.js`, `docs/TELEGRAM_ARCHITECTURE.md`, `docs/UPSTREAM_SYNC.md`, `scripts/telegram-bot.mjs`, `scripts/set-webhook.mjs`, `worker/`, `wrangler.toml`, `scripts/sync-from-selfcrm.mjs`, `.github/workflows/ci.yml`, `.github/workflows/deploy-worker.yml`, `.github/workflows/sync-from-selfcrm.yml`, `.github/workflows/telegram-release.yml.disabled`, `.sync-state.json`, `android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml` (передний план адаптивного значка — в upstream он не нужен, там знак рисует `scripts/make-icons.py`) |
| Только в upstream | `.github/workflows/telegram-release.yml`, `scripts/make-icons.py` и обложки `release-assets/v1.5.1`, `release-assets/v1.5.2`, `release-assets/v1.6.0`, `release-assets/v1.6.1`, `release-assets/v1.7.0`: здесь релизы не публикуются, поэтому обложек для новых версий нет |

**Файлы с локальной адаптацией** — 19 в `src/**` (все перечислены ниже) и вне `src/`:
`index.html`, `package.json`, `.gitignore`, `.env.example`, `README.md`, `ARCHITECTURE.md`,
`ANDROID.md`, `docs/TELEGRAM_RELEASES.md`, `.github/workflows/deploy-pages.yml` и ассеты значка
и заставки (`android/app/src/main/res/**`). Их придётся сливать вручную, если upstream их тронет:

| Файл | Чем отличается |
| --- | --- |
| `src/main.tsx` | регистрация service worker (`public/sw.js`) для офлайн-запуска и моста отчёта (`registerTelegramReportFiles()`, `src/telegram/files.ts`) |
| `src/App.tsx` | подключение `TelegramShell`; маршрут `/feedback` приезжает из upstream, но вставляется вручную |
| `src/components/Icons.tsx` | иконки страницы чека (`print`, `share`, `link`) |
| `src/state/ThemeContext.tsx` | тема Telegram синхронизируется с темой приложения |
| `src/components/UpdateToast.tsx` | проверка обновлений только на нативной платформе |
| `src/version.ts` | репозиторий обновлений: `doc9830/selfcrm-tg` вместо `doc9830/SelfCRM` |
| `src/index.css` | safe area Telegram (`--tg-safe-area-inset-*`), высота окна |
| `src/screens/Settings.tsx` | раздел Telegram, облачная копия, предпросмотр перед импортом; служебные копии в мини-приложении отдаются иначе, чем файлом: «Вернуть» (состояние до импорта возвращается прямо в приложении) и «Скопировать» (повреждённые данные текстом) вместо «Скачать» |
| `src/screens/OrderDetail.tsx` | чек и «Поделиться» вместо сохранения файла |
| `src/utils/navigation.ts`, `src/utils/navigation.test.ts` | распознавание адреса клиента внутри Telegram и `openExternalLink` для ссылок; внутри мини-приложения маршрут открывает страница-мост `public/route.html` (`routeBridgeUrl()`): клиент пропускает через `openLink` только `http`/`https`, поэтому `geo:` отдаёт браузер клиента — Android показывает системный выбор навигатора, как в upstream; в браузере адрес отдаётся Яндекс.Картам поиском (`?text=<адрес>`), маршрутная ссылка — только по координатам |
| `src/db/addresses.ts`, `src/db/addresses.test.ts` | `readUserAddresses()` — отличает свою базу адресов от демо-набора |
| `src/pdf/documents.ts` | отдача документа браузеру вместо файловой системы |
| `src/db/backup.ts` | сохранение файла копии: веб-загрузка и `Share` вместо `Filesystem`; имена служебных копий (`preImportFileName()`, `corruptedFileName()`) и разбор копии перед импортом (`parsePreImportCopy()`): в мини-приложении её отдают не файлом, а возвратом данных на месте |
| `src/db/backup.test.ts` | проверки формата копии, облака и BOM, возврата копии до импорта и имён служебных копий; проверка записи файла с `Encoding.UTF8` живёт в версии этого теста в upstream |
| `index.html` | CSP, `telegram-web-app.js`, тема до первой отрисовки |
| `package.json` | версия и состав зависимостей Telegram-слоя |
| `.gitignore`, `.env.example` | локальные файлы протокола и бота, переменные сборки Mini App |
| `README.md`, `ARCHITECTURE.md`, `ANDROID.md` | описание Telegram-версии; в `ANDROID.md` дополнительно сказано, что подписи (`keystore.properties`) в этой копии нет и для проверки сборки хватает `assembleDebug` |
| `docs/TELEGRAM_RELEASES.md` | пометка, что автопубликация релизов здесь отключена |
| `src/api/dadata.ts`, `src/api/dadata.test.ts` | общий запрос подсказок `requestSuggestions()` и `toAddressPoint()`: точность координат (`qc_geo`) нужна маршруту |
| `src/screens/ClientDetail.tsx` | комментарий к кнопке маршрута: с адресом Яндекс ищет улицу и дом сам, без адреса — по сохранённым координатам |
| `.github/workflows/deploy-pages.yml` | здесь публикует Mini App на Pages (плюс пояснение адреса и `base: './'` в шапке файла); в upstream тот же workflow собирает веб-версию приложения |
| ассеты значка и заставки (`android/app/src/main/res/**`) | здесь остались шаблонные ресурсы Capacitor (фон `#FFFFFF`, сетка-направляющие в `ic_launcher_background.xml`), в upstream — знак «S» и синий фон, собранные `scripts/make-icons.py` |

**Файлы только здесь** (upstream не должен их перезаписывать):

```text
src/telegram/**                     слой Telegram WebApp (включая files.ts — отчёт временной ссылкой)
src/components/TelegramShell.tsx    мост React ↔ события Telegram
src/components/SupportBanner.tsx    плашка «Поддержите разработку» на главном экране
src/utils/support.ts (+ тест)       правила показа плашки, суммы и ссылки на счета
src/db/supportState.ts (+ тест)     хранение состояния плашки: облако Telegram или localStorage
src/db/backupFormat.ts (+ тесты)    формат файла копии v1 и его разбор
src/db/cloudBackup.ts (+ тест)      облачная копия базы в Telegram CloudStorage
src/pdf/receipt.ts, src/pdf/receiptDelivery.ts (+ тесты)  чек: сборка и отдача в облако
src/pdf/documents.test.ts           проверки отдачи документа браузером
src/screens/ReceiptView.tsx         экран чека в мини-приложении
public/sw.js                        service worker: офлайн-оболочка страницы
docs/TELEGRAM_ARCHITECTURE.md       эксплуатация Mini App
docs/UPSTREAM_SYNC.md               этот документ
scripts/telegram-bot.mjs            утилиты бота @fastcrm_bot (setup, предпросмотр «что нового», ссылки на счета)
scripts/set-webhook.mjs             установка, проверка и удаление webhook бота
worker/src/                         runtime бота: Cloudflare Worker с приёмом обновлений по webhook
wrangler.toml                       настройка Worker (имя, точка входа, WEBAPP_URL)
scripts/sync-from-selfcrm.mjs       перенос изменений upstream
.github/workflows/sync-from-selfcrm.yml, .github/workflows/ci.yml
.github/workflows/deploy-worker.yml
.github/workflows/telegram-release.yml.disabled
.sync-state.json, .env (не коммитится)
```

### Пример: перенос 1.5.0 → 1.5.1 (обратная связь)

Реальный запуск 25.09.2026 (`38959c9e7a..d6f738fb0a`) — как это выглядит на практике:

* **перенесено автоматически (8 файлов):** `src/utils/feedback.ts` (+ `feedback.test.ts`),
  `src/screens/Feedback.tsx`, `src/utils/links.ts` (+ тест), `src/utils/back.ts` (+ тест),
  `android/app/build.gradle`. Обратная связь (`mailto:doc9830@proton.me`) работает в Mini App
  без единой правки: письмо открывает клиент Telegram (`openLink`), потому что определение
  встроенного WebView живёт в самом `src/utils/feedback.ts`, а не в адаптации копии;
* **слито вручную (9 файлов):** строка входа в `src/screens/Settings.tsx`, маршрут в
  `src/App.tsx`, иконка `mail` в `src/components/Icons.tsx`, стили `.feedback-mail` в
  `src/index.css`, `APP_VERSION` в `src/version.ts`, версия в `package.json`, экспорт
  `isNativeAndroid()` в `src/utils/navigation.ts` и правки в `README.md`/`ARCHITECTURE.md`;
* **попутно нашлась ловушка:** `src/db/backup.test.ts` держал версию строкой (`'1.5.0'`) —
  теперь берёт `APP_VERSION`, чтобы подъём версии не ломал тесты.

Повторный перенос по тому же коммиту (правка `src/utils/feedback.ts` после первого прогона)
занял один запуск скрипта: два файла перемотались сами, лишних конфликтов не появилось.

### Пример: перенос 1.5.1 → 1.5.2 (копии, обратная связь, поддержка)

* **перенесено как есть (общие файлы):** `src/db/backupText.ts` (новый модуль подготовки текста
  копии: BOM и пробелы по краям), `src/db/database.ts` (+ `database.test.ts`) — понятное
  сообщение вместо технического «Unexpected token»; `src/utils/feedback.ts` (+ тест) — письмо
  отдаётся странице-мосту вместо `mailto:`; `public/mailto.html` (новая страница) — общий файл
  обеих версий;
* **слито вручную:** `src/db/backup.ts` (та же правка, что в upstream: `Encoding.UTF8` при
  записи файла), `src/db/backupFormat.ts` (разбор через `parseBackupJson`), `src/db/backup.test.ts`
  (тесты BOM остались здесь, проверка записи файла — в upstream), `src/index.css`, `src/App.tsx`,
  `README.md`, `docs/*`;
* **появилось только здесь:** плашка поддержки (`SupportBanner.tsx`, `utils/support.ts`,
  `db/supportState.ts` с тестами), команды бота `/support` и `/paysupport`, ссылки на счета.

Практический приём для общих файлов: править их в upstream и переносить патчем
(`git diff -- <файлы>` → `git apply` в этом репозитории) — тогда расхождения остаются только
там, где они действительно нужны.

### Пример: перенос 1.6.1 → 1.7.0 (отчёт в Excel и «К оплате»)

Запуск 26.09.2026 (`babd21944c..334e650f0d`) — первая проверка правила минимальной дивергенции
на большой функции:

* **перенесено автоматически (17 файлов):** весь общий слой отчёта
  (`src/reports/report.ts`, `xlsx.ts`, `delivery.ts`, `export.ts` с тестами — 7 файлов),
  экран `src/screens/Debts.tsx`, изменения `src/screens/Statistics.tsx` (кнопка «Экспорт в
  Excel»), `src/screens/Dashboard.tsx` (плашка «К оплате»), `src/utils/payments.ts` (+ тест),
  `src/utils/orders.ts` (+ тест), `src/utils/links.ts`, `src/utils/back.ts` (+ тест);
* **ни одной новой адаптации:** `Statistics.tsx` остался байт в байт таким же, как в
  Android-версии, потому что доставку файла выбирает общая функция `planReportDelivery`, а
  мост Telegram платформа ставит сама — `registerTelegramReportFiles()` в `src/main.tsx`
  (файл уже был в списке адаптаций). Это ровно тот случай, ради которого слой Telegram держится
  отдельно: про WebView клиента знает только `src/telegram/files.ts`;
* **слито вручную (4 файла):** `src/App.tsx` (маршрут `/debt` рядом с чеками и `TelegramShell`),
  `src/index.css` (стили `.debt-*` и тёмная тема), `package.json` (+ `write-excel-file`) и
  `package-lock.json`;
* **появилось только здесь:** `src/telegram/files.ts` (+ тест) — загрузка файла в хранилище
  Worker'а и скачивание клиентом, `worker/src/files.ts` (+ тест) — сами маршруты `/files`,
  привязка KV `REPORT_FILES` в `wrangler.toml`.

Позже, уже после переноса, здесь появился второй путь доставки — кнопка «Поделиться»: файл уходит
документом в чат, который выберет пользователь (родное меню клиента `WebApp.shareMessage`, а
сообщение собирает бот — `savePreparedInlineMessage`). В Android-версии такого пути нет, поэтому
всё это живёт только здесь: `worker/src/share.ts` и `worker/src/webappAuth.ts` (+ тесты), путь
`share` у моста в `src/telegram/files.ts`, `shareReportFile()` / `shareReportAvailable()` в
`src/reports/delivery.ts`, `shareReport()` в `src/reports/export.ts`, `shareTelegramMessage()` в
`src/telegram/webapp.ts` и вторая кнопка в `src/screens/Statistics.tsx` — с этого момента этот
экран расходится с Android-версией, и при следующем переносе он идёт через ручное слияние.

## 2. Правило минимальной дивергенции

Список из 19 файлов `src/**` (плюс девять файлов вне `src/`) — это цена адаптации: чем он
длиннее, тем чаще синхронизация упирается в ручное слияние. Поэтому:

- Telegram-логику складываем в отдельные модули (`src/telegram/**`, `TelegramShell.tsx`),
  а не размазываем по общим файлам. Именно поэтому 59 файлов `src/**` совпадают с upstream байт
  в байт (это 76% от 78 файлов `src/**` в upstream);
- правка в файле из списка «совпадает с upstream» — исключительный случай: каждый такой файл
  становится ещё одной точкой конфликта;
- обратный перенос полезен тоже: наши доработки копий (`src/db/backupFormat.ts`, предпросмотр
  импорта, `readUserAddresses()`) логично со временем внести и в Android-версию.

## 3. Способ A (реализован): автопорт через GitHub Actions

Workflow `.github/workflows/sync-from-selfcrm.yml` — запуск по расписанию (по понедельникам),
вручную (`workflow_dispatch`) и по внешнему сигналу (`repository_dispatch` типа `selfcrm-updated`,
чтобы перенос начинался сразу после релиза Android-версии):

1. клонирует `doc9830/SelfCRM` (репозиторий публичный, токен не нужен, upstream не меняется);
2. запускает `scripts/sync-from-selfcrm.mjs`: тот читает `.sync-state.json` — SHA последнего
   синхронизированного коммита upstream — и собирает список файлов, изменившихся после него;
3. по каждому файлу — трёхстороннее сравнение:

   | наш файл vs прежняя версия upstream | что делаем |
   | --- | --- |
   | совпадает (локальных правок нет) | переносим новую версию upstream |
   | уже совпадает с новой версией | пропускаем |
   | отличается (есть локальная адаптация) | не трогаем, пишем в отчёт о конфликтах |

4. отдельно решаются два частных случая: файлы вне области синхронизации (сборочные workflow,
   ассеты релизов) попадают в отчёт «вне области», а `package-lock.json` не переносится без
   `package.json` — иначе `npm ci` получит лок без своей версии зависимостей;
5. прогоняет `npm ci`, `tsc --noEmit`, `vitest run` и сборку **до** публикации: PR, созданные
   `GITHUB_TOKEN`, событий не порождают, поэтому отдельный CI на такой PR не сработал бы;
6. коммитит результат в ветку `sync/selfcrm-<12 знаков SHA>`, обновляет `.sync-state.json`
   и открывает (или обновляет) pull request с отчётом: что перенесено, что требует ручного
   решения. Если новостей нет, ветка и PR не создаются — репозиторий остаётся чистым;
7. после мерджа в `main` деплой Pages пересобирает Mini App — новые функции видны в боте сразу,
   без релизов и переустановки.

Плюсы: ничего не перезаписывается силой, конфликты видно глазами, PR можно не мерджить.
Минусы: файлы из таблицы выше всё равно требуют ручного слияния, если upstream их менял.
Проверить план до запуска workflow можно локально:
`node scripts/sync-from-selfcrm.mjs --upstream <клон SelfCRM>` (без `--apply` ничего не меняет).

## 4. Способ B (не выбран): сделать репозиторий настоящим форком

Если слить историю: один раз переписать базу этого репозитория на коммит upstream и дальше
жить как форк. Тогда синхронизация — обычный `git merge upstream/main` (или кнопка «Sync fork»
в интерфейсе GitHub): git делает трёхстороннее слияние по истории, а не по файлам, и видно,
какой коммит и зачем изменил файл.

Цена: текущая история этого репозитория (5 коммитов копии) будет переписана — нужен force-push,
а старых коммитов в `main` не останется (ветку можно сохранить для истории). Набор конфликтов
тот же — 19 файлов `src/**` плюс файлы вне `src/`, но решаются штатными средствами git.
Решение за владельцем репозитория.

## 5. Способ C (не выбран): сократить дивергенцию в самом upstream

Если в `doc9830/SelfCRM` убрать платформенные различия за один признак (например,
`src/platform.ts` с `isAndroid` / `isWeb` / `isTelegram`), файлы `main.tsx`, `App.tsx`,
`ThemeContext.tsx`, `UpdateToast.tsx`, `version.ts`, `index.css`, `index.html` перестанут
расходиться — и способ A станет почти бесконфликтным. Минус: это правки в Android-репозитории,
которые техзадание Telegram-версии запрещает — только по решению владельца.

## 6. Бот и «новые фишки»

- **Mini App** — то, что открывает бот, — всегда берётся с GitHub Pages. После мерджа синка
  бот показывает новую версию сам: никаких действий в боте не требуется.
- **Сообщения бота** — команда `/whatsnew` (реализована): бот читает последний релиз
  `doc9830/SelfCRM` через публичный GitHub API и присылает название версии, changelog
  и кнопки «Открыть SelfCRM» и «Релиз на GitHub». Новых секретов не нужно; кэша нет —
  Worker не хранит состояние между запросами, а лимит GitHub (60 запросов в час без токена)
  для ручной команды не проблема: если лимит исчерпан, бот присылает ссылку на страницу
  релизов. Текст можно посмотреть без отправки: `npm run bot -- --whatsnew`.
- **Push-уведомление «вышла новая версия»** стало возможным: бот работает не на машине
  разработчика, а в Cloudflare Worker и принимает обновления круглосуточно, поэтому сообщение
  о новом релизе можно отправлять из workflow без запущенного компьютера.

## 7. Итог

Выбран и реализован способ **A**: перенос идёт через workflow и pull request, ничего не
перезаписывается силой, а отчёт о конфликтах виден прямо в описании PR. `/whatsnew` добавлена
как часть «видно в боте» — и в Mini App, и в сообщениях бота.

Что можно сделать дальше:

1. Способ **C** — по вашему решению: сократить список расхождений в самом SelfCRM, чтобы
   автопорт почти не упирался в ручное слияние.
2. Способ **B** — если понадобятся полноценные merge-семантики: ценой переписывания истории
   этого репозитория.
3. Повесить `repository_dispatch` (`selfcrm-updated`) в релизный workflow Android-версии, чтобы
   перенос стартовал сразу после публикации релиза, не дожидаясь понедельника.
