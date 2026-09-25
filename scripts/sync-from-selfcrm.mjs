#!/usr/bin/env node
// Перенос новых функций Android-версии (doc9830/SelfCRM) в этот репозиторий.
//
// Фичи разрабатываются в Android-репозитории, а это его копия с адаптацией под Telegram
// (см. docs/UPSTREAM_SYNC.md). Сравнивать деревья руками нельзя, поэтому работа идёт по
// правилу трёх версий — наша, upstream до синхронизации, upstream сейчас:
//
//   наш файл == версия upstream до   → переносим новую версию (fast-forward);
//   наш файл == версия upstream после → уже актуально, ничего не делаем;
//   иначе (в файле наша адаптация)    → конфликт: не трогаем, пишем в отчёт.
//
// Скрипт не делает commit, push и не открывает pull request — это работа workflow
// `.github/workflows/sync-from-selfcrm.yml`. Без `--apply` он ничего не меняет (план).
//
// Примеры:
//   git clone https://github.com/doc9830/SelfCRM.git /tmp/selfcrm-upstream
//   node scripts/sync-from-selfcrm.mjs --upstream /tmp/selfcrm-upstream
//   node scripts/sync-from-selfcrm.mjs --upstream /tmp/selfcrm-upstream --apply --report sync-report.md
//
// Зависимостей нет: git вызывается через child_process, файлы читаются напрямую.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_STATE = join(ROOT, '.sync-state.json')

// Что переносим: каталоги и файлы, общие с Android-версией. Всё остальное (workflow,
// обложки релизов, наши документы) остаётся нетронутым, но попадает в отчёт.
const SYNC_PATHS = [
  'src/',
  'public/',
  'scripts/',
  'android/',
  'docs/',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'capacitor.config.ts',
  '.env.example',
  '.gitignore',
  'README.md',
  'ARCHITECTURE.md',
  'ANDROID.md',
  'LICENSE',
]

// Наши файлы: upstream их не перезаписывает никогда, даже если версии когда-то совпали.
const LOCAL_ONLY = [
  'src/telegram/',
  'src/components/TelegramShell.tsx',
  'src/db/backupFormat.ts',
  'src/db/backupFormat.test.ts',
  'public/sw.js',
  'scripts/telegram-bot.mjs',
  'docs/TELEGRAM_ARCHITECTURE.md',
  'docs/UPSTREAM_SYNC.md',
]

// Зависимости переносятся только вместе: лок без своего package.json сломает `npm ci`,
// поэтому при конфликте в package.json лок тоже не трогаем.
const COUPLED = { 'package-lock.json': 'package.json' }

const USAGE = `Синхронизация с Android-версией SelfCRM (doc9830/SelfCRM).

Аргументы:
  --upstream <path>   каталог клона doc9830/SelfCRM (обязательно)
  --repo <path>       наш репозиторий (по умолчанию корень проекта)
  --state <path>      файл состояния (по умолчанию .sync-state.json)
  --from <sha>        взять версию upstream явно, вместо состояния
  --report <path>     записать отчёт в markdown-файл
  --apply             применить перенос (без флага — только показать план)
  --help              эта справка

Коды возврата: 0 — план посчитан, 1 — ошибка ввода.`

function parseArgs(argv) {
  const args = { upstream: null, repo: ROOT, state: DEFAULT_STATE, from: null, report: null, apply: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--upstream') args.upstream = argv[++i] ?? null
    else if (arg === '--repo') args.repo = argv[++i] ?? ROOT
    else if (arg === '--state') args.state = argv[++i] ?? DEFAULT_STATE
    else if (arg === '--from') args.from = argv[++i] ?? null
    else if (arg === '--report') args.report = argv[++i] ?? null
    else if (arg === '--apply') args.apply = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

// git с понятной ошибкой: путь и аргументы видно в тексте, секретов здесь нет.
function git(args, options = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  } catch (e) {
    throw new Error(`git ${args.join(' ')}: ${String(e.stderr || e.message).trim()}`)
  }
}

// Содержимое файла в ревизии upstream. null — файла в этой ревизии нет.
// stderr подавляется: «path ... exists on disk, but not in <rev>» — нормальная ситуация
// (в старой версии файла ещё не было), а не ошибка.
function upstreamBlob(dir, rev, path) {
  try {
    return execFileSync('git', ['-C', dir, 'cat-file', 'blob', `${rev}:${path}`], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path) : null
}

function same(a, b) {
  if (a === null || b === null) return a === b
  return a.equals(b)
}

function inList(path, list) {
  return list.some((item) => (item.endsWith('/') ? path.startsWith(item) : path === item))
}

// Является ли `from` предком `to` — проверка направления диапазона (см. main()).
function isAncestor(dir, from, to) {
  try {
    execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', from, to], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function changedFiles(dir, from, to) {
  const out = git(['-C', dir, 'diff', '--name-status', '--no-renames', `${from}..${to}`])
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status: status.trim().slice(0, 1), path: rest.join('\t').trim() }
    })
    .filter((item) => item.path)
}


// Решение по файлу: ours/old/next — Buffer или null (файла нет).
function decide(ours, old, next) {
  if (same(ours, next)) return 'same'
  if (same(ours, old)) return 'apply'
  return 'conflict'
}

function describeChange(old, next) {
  if (old === null && next !== null) return 'добавлен в upstream'
  if (old !== null && next === null) return 'удалён в upstream'
  return 'изменён в upstream'
}

function collectEntries(args, upstreamDir, head) {
  const entries = changedFiles(upstreamDir, args.from, head).map((file) => {
    const ours = readIfExists(join(args.repo, file.path))
    const old = upstreamBlob(upstreamDir, args.from, file.path)
    const next = upstreamBlob(upstreamDir, head, file.path)
    const scope = !inList(file.path, SYNC_PATHS) ? 'outside' : inList(file.path, LOCAL_ONLY) ? 'local' : 'tracked'
    return {
      ...file,
      ours,
      old,
      next,
      scope,
      action: scope === 'tracked' ? decide(ours, old, next) : scope,
      change: describeChange(old, next),
    }
  })

  // Парные файлы (зависимости): если у партнёра конфликт, перенос откладывается,
  // иначе получится package-lock без своего package.json и `npm ci` упадёт.
  for (const entry of entries) {
    const partner = COUPLED[entry.path]
    if (entry.action !== 'apply' || !partner) continue
    const blocker = entries.find((other) => other.path === partner && other.action !== 'apply' && other.action !== 'same')
    if (blocker) {
      entry.action = 'deferred'
      entry.reason = `не переносим без ${partner}: там ${blocker.action === 'conflict' ? 'конфликт' : 'файл вне области синхронизации'}`
    }
  }

  return entries
}

function table(rows, headers, limit = 100) {
  if (rows.length === 0) return ['(пусто)']
  const shown = rows.slice(0, limit).map((row) => `| ${row.join(' | ')} |`)
  if (rows.length > limit) shown.push(`| … | ещё ${rows.length - limit}, смотрите лог запуска |`)
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...shown]
}

function buildReport(entries, meta) {
  const applied = entries.filter((e) => e.action === 'apply')
  const conflicts = entries.filter((e) => e.action === 'conflict')
  const deferred = entries.filter((e) => e.action === 'deferred')
  const same = entries.filter((e) => e.action === 'same')
  const outside = entries.filter((e) => e.scope !== 'tracked')

  const lines = [
    '# Синхронизация с doc9830/SelfCRM',
    '',
    `- Диапазон upstream: \`${meta.from.slice(0, 10)}\` → \`${meta.head.slice(0, 10)}\``,
    `- Режим: ${meta.mode}`,
    `- Итог: перенесено ${applied.length}, конфликтов ${conflicts.length}, отложено ${deferred.length},`,
    `  вне области ${outside.length}, уже актуально ${same.length}`,
    '',
  ]

  if (applied.length === 0 && conflicts.length === 0 && deferred.length === 0) {
    lines.push('Новых изменений, требующих переноса, нет.', '')
  }

  lines.push('## Перенесено', '', ...table(applied.map((e) => [`\`${e.path}\``, e.change]), ['файл', 'что']), '')
  lines.push('## Конфликты: нужны руки', '')
  if (conflicts.length === 0) {
    lines.push('(нет)', '')
  } else {
    lines.push(
      'В этих файлах есть наша адаптация под Telegram, поэтому скрипт их не трогает.',
      `Правки upstream видно командой \`git -C <клон SelfCRM> show ${meta.head.slice(0, 10)} -- <файл>\`;`,
      'перенесите нужное вручную в этой же ветке.',
      '',
      ...table(conflicts.map((e) => [`\`${e.path}\``, e.change]), ['файл', 'что в upstream']),
      '',
    )
  }
  if (deferred.length > 0) {
    lines.push('## Отложено', '', ...table(deferred.map((e) => [`\`${e.path}\``, e.reason ?? '']), ['файл', 'почему']), '')
  }
  lines.push('## Вне области синхронизации', '')
  if (outside.length === 0) {
    lines.push('(нет)', '')
  } else {
    lines.push(
      'Эти файлы изменились в upstream, но переносятся вручную: они относятся к сборочным',
      'workflow, ассетам релизов или нашим документам.',
      '',
      ...table(outside.map((e) => [`\`${e.path}\``, e.change]), ['файл', 'что в upstream']),
      '',
    )
  }
  lines.push(
    '---',
    '',
    'Правило переноса и список общих файлов — [docs/UPSTREAM_SYNC.md](./docs/UPSTREAM_SYNC.md).',
    'После мерджа в `main` GitHub Pages пересобирает Mini App, поэтому новые функции видны',
    'в боте сразу — релизы и переустановка не нужны.',
    '',
    '_Отчёт сгенерирован `scripts/sync-from-selfcrm.mjs`._',
  )
  return lines.join('\n')
}


function tagOf(upstreamDir, rev) {
  try {
    return git(['-C', upstreamDir, 'describe', '--tags', '--exact-match', rev]).trim()
  } catch {
    return null
  }
}

function applyEntry(repoDir, entry) {
  const target = join(repoDir, entry.path)
  if (entry.next === null) {
    rmSync(target, { force: true })
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, entry.next)
}

function count(entries, action) {
  return entries.filter((entry) => entry.action === action).length
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (!args.upstream) {
    console.error(`Не задан --upstream <path>.\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  const state = existsSync(args.state) ? JSON.parse(readFileSync(args.state, 'utf8')) : {}
  // Версия-база: явный --from (нужен для проверок) или из файла состояния.
  args.from = args.from ?? state.commit ?? null
  if (!args.from) {
    console.error(`Неизвестно, с какой версии upstream синхронизировать: нет ${args.state} и не задан --from.`)
    process.exitCode = 1
    return
  }

  const head = git(['-C', args.upstream, 'rev-parse', 'HEAD']).trim()
  // База проверяется до сравнения файлов: иначе «неизвестная ревизия» всплыла бы в середине плана.
  git(['-C', args.upstream, 'cat-file', '-e', `${args.from}^{commit}`])

  // Защита от переноса «назад»: если база не предок целевого коммита (например, запуск с тегом
  // старой версии или после переписывания истории upstream), диапазон обратный — такой перенос
  // откатил бы файлы. Здесь лучше остановиться и попросить явный --from.
  if (!isAncestor(args.upstream, args.from, head)) {
    console.error(
      `Коммит ${args.from.slice(0, 10)} не является предком ${head.slice(0, 10)}: перенос откатил бы файлы. ` +
        'Проверьте .sync-state.json или задайте --from явно.',
    )
    process.exitCode = 1
    return
  }

  const entries = collectEntries(args, args.upstream, head)
  const counts = {
    apply: count(entries, 'apply'),
    conflict: count(entries, 'conflict'),
    deferred: count(entries, 'deferred'),
    same: count(entries, 'same'),
    outside: count(entries, 'outside') + count(entries, 'local'),
  }

  const report = buildReport(entries, {
    from: args.from,
    head,
    mode: args.apply ? 'перенос применён в рабочем дереве' : 'план, изменения не применяются',
  })
  if (args.report) {
    mkdirSync(dirname(args.report), { recursive: true })
    writeFileSync(args.report, report)
  }

  for (const entry of entries) {
    if (entry.action === 'apply') console.log(`  перенос   ${entry.path} (${entry.change})`)
    else if (entry.action === 'conflict') console.log(`  конфликт  ${entry.path} (${entry.change})`)
    else if (entry.action === 'deferred') console.log(`  отложено  ${entry.path}: ${entry.reason}`)
  }

  if (args.apply) {
    for (const entry of entries.filter((item) => item.action === 'apply')) applyEntry(args.repo, entry)

    // Состояние обновляется, только если перенос что-то дал или upstream ушёл вперёд.
    // Иначе еженедельный запуск без новостей оставлял бы в репозитории пустой PR.
    const hasNews = counts.apply > 0 || state.commit !== head
    if (hasNews) {
      const next = {
        ...state,
        upstream: state.upstream ?? 'doc9830/SelfCRM',
        branch: state.branch ?? 'main',
        commit: head,
        tag: tagOf(args.upstream, head) ?? state.tag ?? null,
        syncedAt: new Date().toISOString().slice(0, 10),
        lastSync: { applied: counts.apply, conflicts: counts.conflict, deferred: counts.deferred },
      }
      writeFileSync(args.state, `${JSON.stringify(next, null, 2)}\n`)
      console.log(`Состояние обновлено: ${args.state} → ${head.slice(0, 10)}`)
    } else {
      console.log(`Состояние уже актуально: ${args.state} (${head.slice(0, 10)})`)
    }
  }

  console.log(
    [
      `Upstream: ${args.from.slice(0, 10)}..${head.slice(0, 10)}`,
      `Перенесено: ${counts.apply}, конфликтов: ${counts.conflict}, отложено: ${counts.deferred}, вне области: ${counts.outside}, уже актуально: ${counts.same}`,
      args.report ? `Отчёт: ${args.report}` : 'Отчёт не сохранён (нет --report)',
    ].join('\n'),
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
