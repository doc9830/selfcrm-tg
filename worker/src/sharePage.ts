// Страница «Поделиться»: файл уходит системному меню телефона.
//
// Зачем она нужна. Кнопка выгрузки в мини-приложении открывает этот адрес в браузере
// телефона (`WebApp.openLink`), а страница отдаёт файл системному меню «Поделиться»
// (`navigator.share` с файлом): из меню файл сохраняют в «Файлы», отправляют в мессенджер
// или печатают. Так выгрузка одинакова во всех версиях приложения: в сборке Capacitor
// системное меню открывает плагин, здесь — браузер, а сам файл собирает приложение
// (см. src/reports/delivery.ts и src/telegram/files.ts).
//
// Почему страница живёт на Worker'е, а не на GitHub Pages. Файл отдаёт та же машина, что
// и страницу: браузеры отдают системному меню файл со своего домена, а на Pages временного
// файла нет — он лежит в хранилище Worker'а (worker/src/files.ts).
//
//   GET /share/<id>?text=<подпись> — страница: имя файла, кнопка «Поделиться» и запасная
//                                    ссылка «Скачать файл» на тот же документ
//
// Страница ничего не решает сама: имя и тип файла она читает из хранилища по одному
// идентификатору (как и само скачивание — без подписи и без токена), а подпись приходит
// строкой запроса и выводится текстом. Меню открывает `navigator.share`, и вызывать его
// нужно нажатием: браузеры (особенно Safari на iPhone) не показывают меню без жеста,
// поэтому файл страница забирает заранее, а по нажатию отдаёт уже готовый.
import { FILES_PATH, message, readStoredFile, type FilesEnv, type StoredFile } from './files'

// Хвост адреса страницы: `/share/<id>`. Путь отличается от файлов (`/files/<id>`) намеренно:
// файлы отдают сам документ, а страница — разметку.
export const SHARE_PAGE_PATH = '/share'

// Шаблон идентификатора повторяет слой файлов: чужой ключ хранилища страницей не перебрать.
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

// Подпись файла в системном меню: предел тот же, что у подписи сообщения «Поделиться»
// (worker/src/share.ts) — текст приходит от клиента, поэтому длина ограничена.
const MAX_TEXT_LENGTH = 400

// Точка входа страницы. null означает «это не адрес страницы» — тогда запрос обрабатывают
// файлы и роуты бота (см. worker/src/index.ts).
export async function handleSharePage(request: Request, env: FilesEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== SHARE_PAGE_PATH && !url.pathname.startsWith(`${SHARE_PAGE_PATH}/`)) {
    return null
  }

  if (request.method !== 'GET') return message('Method not allowed\n', 405)

  const store = env.REPORT_FILES
  if (!store) {
    console.error('Не задано хранилище REPORT_FILES: добавьте привязку KV (см. wrangler.toml)')
    return message('Файлы временно недоступны\n', 503)
  }

  const id = url.pathname.slice(SHARE_PAGE_PATH.length + 1)
  const file = ID_PATTERN.test(id) ? await readStoredFile(store, id) : null
  if (!file) return page(gonePage, 404)

  return page((nonce) => filePage(id, file, shareText(url.searchParams.get('text')), nonce), 200)
}

// Подпись файла: из текста убираются управляющие символы (переводы строк, табуляция), а
// длина ограничивается. Пустая подпись — файл уходит без текста.
function shareText(raw: string | null): string {
  if (!raw) return ''
  return raw
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
}

// Ответ страницы: свой заголовок содержимого, запрет на кэш, встраивание и индексацию.
// Страница ничего не подгружает извне, поэтому CSP строгий: скрипт и стили разрешены
// одноразовым nonce — чужой скрипт на нашем адресе не выполнится.
function page(render: (nonce: string) => string, status: number): Response {
  const value = nonce()
  return new Response(render(value), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${value}'`,
        `style-src 'nonce-${value}'`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

// Одноразовый nonce для скрипта и стилей страницы: тот же приём, что у CSP без исключений.
function nonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/[+/=]/g, '')
}

// Значение внутри скрипта: JSON плюс экранирование символов, которыми можно закрыть
// `<script>`. Имя файла и подпись приходят снаружи, поэтому разметку они не разорвут.
function scriptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// Текст в разметке: имя файла приходит из хранилища, подпись — из строки запроса.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}



// Страница с файлом: имя, подпись, кнопка «Поделиться» и запасная ссылка на тот же
// документ. Ссылка нужна там, где системного меню нет (настольный браузер), и как второй
// путь, если меню не открылось.
function filePage(id: string, file: StoredFile, text: string, nonce: string): string {
  // Адрес файла — тот же, что отдаёт слой файлов: страница и документ живут на одном
  // домене, поэтому браузер отдаёт файл системному меню без ограничений чужого источника.
  const fileUrl = `${FILES_PATH}/${id}`
  const name = escapeHtml(file.name)
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Поделиться файлом — SelfCRM</title>
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; padding: 24px; display: flex;
        align-items: center; justify-content: center; background: #f4f5f7; color: #1f2328;
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      main { width: 100%; max-width: 420px; }
      .label { margin: 0 0 6px; font-size: 13px; color: #6b7280; }
      .file { margin: 0 0 4px; font-size: 18px; font-weight: 600; word-break: break-all; }
      .caption { margin: 0 0 12px; font-size: 14px; color: #4b5563; }
      button {
        width: 100%; margin-top: 8px; padding: 14px 16px; border: 0; border-radius: 12px;
        font: inherit; font-weight: 600; color: #ffffff; background: #2563eb;
      }
      button:disabled { background: #9ca3af; }
      .save {
        display: block; margin-top: 12px; padding: 12px 16px; border: 1px solid #d1d5db;
        border-radius: 12px; text-align: center; text-decoration: none; color: inherit;
      }
      .note { margin: 16px 0 0; font-size: 13px; color: #6b7280; }
      @media (prefers-color-scheme: dark) {
        body { background: #16181c; color: #e8eaed; }
        .label, .note, .caption { color: #9aa0a6; }
        .save { border-color: #3c4043; }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="label">Файл SelfCRM готов к отправке</p>
      <p class="file">${name}</p>
      ${text ? `<p class="caption">${escapeHtml(text)}</p>` : ''}
      <button id="share" type="button" disabled>Готовим файл…</button>
      <a class="save" id="save" href="${fileUrl}" download="${name}">Скачать файл</a>
      <p class="note" id="note">
        Кнопка открывает системное меню телефона: оттуда файл сохраняют в «Файлы» или
        отправляют в мессенджер. Если меню не появилось, откройте эту страницу в обычном
        браузере (меню «…» → «Открыть в браузере») — оттуда файл отдаёт само системное меню.
      </p>
    </main>
    <script nonce="${nonce}">
      // Меню открывается нажатием, а не загрузкой страницы: без жеста Safari на iPhone
      // отказывает. Поэтому файл забирается заранее, а по нажатию уходит уже готовым.
      var fileUrl = ${scriptValue(fileUrl)};
      var fileName = ${scriptValue(file.name)};
      var shareText = ${scriptValue(text)};
      var button = document.getElementById('share');
      var note = document.getElementById('note');
      var save = document.getElementById('save');
      var ready = null;

      function setNote(text) {
        note.textContent = text;
      }

      fetch(fileUrl, { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('файл недоступен');
          return response.blob();
        })
        .then(function (blob) {
          ready = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
          button.disabled = false;
          button.textContent = 'Поделиться';
        })
        .catch(function () {
          button.textContent = 'Файл больше недоступен';
          save.style.display = 'none';
          setNote('Ссылка перестала работать: файл живёт час. Сформируйте новый в SelfCRM.');
        });

      button.addEventListener('click', function () {
        if (!ready) return;
        if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [ready] })) {
          setNote(
            'Этот браузер не открывает системное меню со страницы — нажмите «Поделиться» в самом браузере или сохраните файл по ссылке «Скачать файл».',
          );
          return;
        }
        var data = { files: [ready], title: fileName };
        if (shareText) data.text = shareText;
        button.disabled = true;
        navigator
          .share(data)
          .then(function () {
            setNote('Файл отправлен. Окно можно закрыть.');
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') {
              setNote('Отмена — нажмите «Поделиться» ещё раз, если нужно.');
            } else {
              setNote(
                'Системное меню не открылось — нажмите «Поделиться» в самом браузере или сохраните файл по ссылке «Скачать файл».',
              );
            }
          })
          .then(function () {
            button.disabled = false;
          });
      });
    </script>
  </body>
</html>
`
}

// Страница устаревшей ссылки: файл живёт час, и об этом нужно сказать прямо, потому что
// «ничего не произошло» выглядит как поломка приложения.
function gonePage(nonce: string): string {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ссылка больше не работает — SelfCRM</title>
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; padding: 24px; display: flex;
        align-items: center; justify-content: center; background: #f4f5f7; color: #1f2328;
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      main { width: 100%; max-width: 420px; }
      .label { margin: 0 0 6px; font-size: 13px; color: #6b7280; }
      .file { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
      .note { margin: 0; font-size: 14px; color: #4b5563; }
      @media (prefers-color-scheme: dark) {
        body { background: #16181c; color: #e8eaed; }
        .label, .note { color: #9aa0a6; }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="label">SelfCRM</p>
      <p class="file">Ссылка больше не работает</p>
      <p class="note">
        Файл хранится час после выгрузки. Выгрузите его в приложении заново — придёт такая
        же ссылка.
      </p>
    </main>
  </body>
</html>
`
}

