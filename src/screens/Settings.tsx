import { useEffect, useRef, useState } from 'react'
import { Button, Card, Field, Input, IntegerInput, Modal, PhoneInput, cx } from '../components/ui'
import { Icon } from '../components/Icons'
import { applyBackup, downloadBackup, downloadJson, hasLocalData, readBackupFile } from '../db/backup'
import {
  backupFileName,
  describeCounts,
  parseBackup,
  summarizeBackup,
  type BackupSummary,
  type ParsedBackup,
} from '../db/backupFormat'
import { parseAddresses, saveAddresses } from '../db/addresses'
import { seedDemo } from '../db/seed'
import { useData } from '../state/DataContext'
import { useTheme } from '../state/ThemeContext'
import { openBotChat } from '../telegram/webapp'
import { emptyContractor, type Contractor } from '../types'
import { INN_LENGTHS, KPP_LENGTHS, OGRN_LENGTHS, hasValidDigitLength, isPhoneValid } from '../utils/input'
import { Capacitor } from '@capacitor/core'
import { downloadUpdate, fetchLatestRelease, installUpdate, isNewerVersion, openExternal, type ReleaseInfo } from '../updates'
import { useRoute } from '../router'
import { APP_VERSION } from '../version'

const isDev = import.meta.env.DEV

// Метка времени для имён скачиваемых файлов (как в src/db/backup.ts).
function fileStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'up-to-date' }
  | {
      status: 'available'
      release: ReleaseInfo
      busy: boolean
      downloaded: boolean
      progress: number
      error?: string
    }

// Состояние восстановления из файла: сначала показываем, что лежит в копии, и только
// после подтверждения пользователя заменяем данные.
type RestoreState =
  | { status: 'idle' }
  | { status: 'invalid'; fileName: string; message: string }
  | {
      status: 'ready'
      fileName: string
      parsed: ParsedBackup
      summary: BackupSummary
      busy: boolean
      error?: string
    }
  | { status: 'done'; summary: BackupSummary }

export function Settings() {
  const { db, refresh } = useData()
  const { theme, toggleTheme } = useTheme()
  const { route } = useRoute()
  const fileRef = useRef<HTMLInputElement>(null)
  const addressFileRef = useRef<HTMLInputElement>(null)
  const updatesRef = useRef<HTMLDivElement>(null)
  const autoCheckedRef = useRef(false)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [restore, setRestore] = useState<RestoreState>({ status: 'idle' })
  // Результат создания копии: пользователю важно прочитать имя файла и что с ним делать.
  const [backupNote, setBackupNote] = useState<string | null>(null)
  // Переход из уведомления о новой версии: «/settings?section=updates».
  const highlightUpdates = route.query.get('section') === 'updates'

  const checkUpdates = async () => {
    setUpdate({ status: 'checking' })
    try {
      const release = await fetchLatestRelease()
      if (!release) {
        setUpdate({ status: 'error', message: 'Релизы не найдены' })
        return
      }
      if (isNewerVersion(release.version, APP_VERSION)) {
        setUpdate({ status: 'available', release, busy: false, downloaded: false, progress: 0 })
      } else {
        setUpdate({ status: 'up-to-date' })
      }
    } catch (e) {
      setUpdate({
        status: 'error',
        message: e instanceof Error ? e.message : 'Не удалось проверить обновления',
      })
    }
  }

  // Переход по уведомлению о новой версии: прокручиваем к блоку «Обновления»
  // и сразу запускаем проверку, чтобы не пришлось нажимать кнопку.
  useEffect(() => {
    if (!highlightUpdates) return
    const timer = window.setTimeout(() => {
      updatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [highlightUpdates])

  useEffect(() => {
    if (!highlightUpdates || autoCheckedRef.current) return
    autoCheckedRef.current = true
    void checkUpdates()
  }, [highlightUpdates, checkUpdates])

  const startUpdate = async (release: ReleaseInfo) => {
    const apkUrl = release.apkUrl
    if (!apkUrl || !Capacitor.isNativePlatform()) {
      await openExternal(apkUrl ?? release.url)
      return
    }

    const alreadyDownloaded = update.status === 'available' && update.downloaded
    setUpdate((prev) =>
      prev.status === 'available'
        ? { ...prev, busy: true, error: undefined }
        : { status: 'available', release, busy: true, downloaded: false, progress: 0, error: undefined },
    )

    try {
      if (!alreadyDownloaded) {
        await downloadUpdate(apkUrl, ({ fraction }) => {
          setUpdate((prev) => (prev.status === 'available' ? { ...prev, progress: fraction } : prev))
        })
        setUpdate((prev) => (prev.status === 'available' ? { ...prev, downloaded: true, progress: 1 } : prev))
      }
      await installUpdate()
      setUpdate((prev) => (prev.status === 'available' ? { ...prev, busy: false, error: undefined } : prev))
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось установить обновление'
      setUpdate((prev) => (prev.status === 'available' ? { ...prev, busy: false, error: message } : prev))
    }
  }

  // Создание копии: файл скачивается на устройство, дальше пользователь сам решает, где его
  // хранить. В Telegram приложение предлагает отправить файл в чат с ботом (см. ниже).
  const handleExport = async () => {
    setBackupNote(null)
    try {
      await downloadBackup(db)
      setBackupNote(`Копия сохранена: ${backupFileName()}`)
    } catch (e) {
      setBackupNote(e instanceof Error ? e.message : 'Не удалось сохранить файл')
    }
  }

  // Файл читается и проверяется сразу, но данные не меняются: сначала показываем, что в копии,
  // и ждём подтверждения. Ошибка разбора — понятное сообщение вместо падения приложения.
  const handleImport = async (file: File | undefined) => {
    if (!file) return
    try {
      const json = await readBackupFile(file)
      const parsed = parseBackup(json)
      setRestore({
        status: 'ready',
        fileName: file.name,
        parsed,
        summary: summarizeBackup(parsed),
        busy: false,
      })
    } catch (e) {
      setRestore({
        status: 'invalid',
        fileName: file.name,
        message: e instanceof Error ? e.message : 'Не удалось прочитать файл',
      })
    }
  }

  // Подтверждённое восстановление. `backupFirst` — кнопка «Создать backup и продолжить»:
  // копия текущих данных скачивается до замены, поэтому импорт не оставляет без данных.
  const runRestore = async (parsed: ParsedBackup, backupFirst: boolean) => {
    setRestore((prev) => (prev.status === 'ready' ? { ...prev, busy: true, error: undefined } : prev))
    try {
      if (backupFirst) await downloadBackup(db)
      const restored = applyBackup(db, parsed)
      refresh()
      setRestore({ status: 'done', summary: summarizeBackup(restored) })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось восстановить данные'
      setRestore((prev) => (prev.status === 'ready' ? { ...prev, busy: false, error: message } : prev))
    }
  }

  // Пока восстановление идёт, окно не закрывается: операция уже началась.
  const closeRestore = () => {
    if (restore.status === 'ready' && restore.busy) return
    setRestore({ status: 'idle' })
  }

  // Замена этих данных необратима, поэтому предупреждение показывается только тогда,
  // когда в базе действительно есть что терять.
  const willReplace = restore.status === 'ready' && hasLocalData(db)
  // Подпись кнопки подтверждения: если данные будут заменены, предлагаем сначала копию.
  const restoreActionLabel =
    restore.status === 'ready' && restore.busy
      ? 'Восстановление…'
      : willReplace
        ? 'Создать backup и продолжить'
        : 'Восстановить'

  // Сохранение файла: начинается скачивание — в Telegram файл попадает в загрузки
  // устройства (им можно поделиться или отправить себе), в браузере — в «Загрузки».
  const runExport = async (exportFile: () => Promise<void>) => {
    try {
      await exportFile()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Не удалось сохранить файл')
    }
  }

  const handleAddressImport = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      const list = parseAddresses(text)
      saveAddresses(list)
      window.alert(`База адресов загружена: ${list.length} записей`)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Не удалось загрузить базу адресов')
    }
  }

  // Копии данных, сохранённые приложением: нечитаемые значения и состояние перед импортом.
  const corruptedKeys = db.listCorruptedBackups()
  const loadWarning = db.getLoadWarning()

  const handleDownloadCorrupted = async () => {
    const [key] = corruptedKeys
    const raw = key ? db.readCorruptedBackup(key) : null
    if (!raw) {
      window.alert('Копия повреждённых данных не найдена')
      return
    }
    await runExport(() => downloadJson(raw, `selfcrm-corrupt-${fileStamp()}.json`))
  }

  const handleDownloadPreImport = async () => {
    const json = db.readPreImportBackup()
    if (!json) {
      window.alert('Копия данных до импорта не найдена')
      return
    }
    await runExport(() => downloadJson(json, `selfcrm-before-import-${fileStamp()}.json`))
  }

  return (
    <div>
      {loadWarning && (
        <Card className="settings-group">
          <div className="limit-banner limit-banner-danger" style={{ marginBottom: 0 }}>
            <span className="limit-banner-icon">
              <Icon name="alert" size={18} />
            </span>
            <span className="limit-banner-text">{loadWarning}</span>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Скачать повреждённые данные</div>
              <div className="settings-row-desc">
                Файл с исходным содержимым хранилища — его можно открыть или прислать для разбора
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              onClick={() => void handleDownloadCorrupted()}
            >
              Скачать
            </Button>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Скрыть предупреждение</div>
              <div className="settings-row-desc">Копия останется в хранилище приложения</div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                db.clearLoadWarning()
                refresh()
              }}
            >
              Понятно
            </Button>
          </div>
        </Card>
      )}

      <Card className="settings-group">
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Тёмная тема</div>
            <div className="settings-row-desc" style={{ marginTop: 4 }}>
              Комфортное отображение при слабом освещении
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={theme === 'dark'}
              onChange={toggleTheme}
              aria-label="Тёмная тема"
            />
            <span className="switch-track" />
          </label>
        </div>
      </Card>

      <Card className="settings-group">
        <div className="section-title" style={{ marginBottom: 6 }}>
          Исполнитель
        </div>
        <div className="settings-row-desc" style={{ marginBottom: 12 }}>
          Реквизиты, которые попадают в чек (PDF): название, ИНН, ОГРН и контакты.
        </div>
        <ContractorForm />
      </Card>

      <Card className="settings-group">
        <div className="section-title" style={{ marginBottom: 6 }}>
          Резервная копия
        </div>
        <div className="settings-row-desc" style={{ marginBottom: 12 }}>
          Данные CRM хранятся на этом устройстве. Чтобы не потерять их при очистке данных
          Telegram или смене устройства, регулярно создавайте резервные копии. Копию можно
          сохранить в Telegram и восстановить на другом устройстве.
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Создать резервную копию</div>
            <div className="settings-row-desc">
              Сохраняет все данные CRM в один файл: клиенты, товары, заказы с напоминаниями,
              история склада и реквизиты
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon="download"
            onClick={() => void handleExport()}
          >
            Создать
          </Button>
        </div>
        {backupNote && (
          <div className="settings-row-desc" style={{ marginBottom: 4 }}>
            {backupNote}
          </div>
        )}
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Восстановить из файла</div>
            <div className="settings-row-desc">
              Восстанавливает CRM из ранее созданной копии. Перед заменой данных приложение
              покажет, что в файле. Подходит и копия из Android-сборки SelfCRM
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon="upload"
            onClick={() => fileRef.current?.click()}
          >
            Выбрать файл
          </Button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Хранить копию в Telegram</div>
            <div className="settings-row-desc">
              Отправьте файл копии в чат с ботом — он останется в истории чата и его можно
              будет скачать на новом устройстве
            </div>
          </div>
          <Button size="sm" variant="secondary" icon="telegram" onClick={() => openBotChat()}>
            Чат с ботом
          </Button>
        </div>
        {db.hasPreImportBackup() && (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Данные до импорта</div>
              <div className="settings-row-desc">
                Копия состояния базы перед последним импортом или сбросом
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              onClick={() => void handleDownloadPreImport()}
            >
              Скачать
            </Button>
          </div>
        )}
        {corruptedKeys.length > 0 && (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Повреждённые данные</div>
              <div className="settings-row-desc">
                Сохранённые копии значений, которые не удалось прочитать: {corruptedKeys.length}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              onClick={() => void handleDownloadCorrupted()}
            >
              Скачать
            </Button>
          </div>
        )}
      </Card>

      <Card className="settings-group">
        <div className="section-title" style={{ marginBottom: 6 }}>
          Данные
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">База адресов</div>
            <div className="settings-row-desc">Импорт кадастровых адресов (JSON)</div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon="upload"
            onClick={() => addressFileRef.current?.click()}
          >
            Импорт
          </Button>
        </div>
        {isDev && (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Демо-данные</div>
              <div className="settings-row-desc">Заполнить демонстрационными данными</div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              onClick={() => {
                seedDemo(db)
                refresh()
              }}
            >
              Заполнить
            </Button>
          </div>
        )}
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Сбросить все данные</div>
            <div className="settings-row-desc">Удалить клиентов, заказы и товары</div>
          </div>
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            onClick={() => {
              if (
                window.confirm(
                  'Удалить все данные? Копия текущего состояния сохранится — её можно будет скачать в разделе «Резервная копия».',
                )
              ) {
                db.reset()
                refresh()
              }
            }}
          >
            Сбросить
          </Button>
        </div>
      </Card>

      <div ref={updatesRef}>
        <Card className={cx('settings-group', highlightUpdates && 'settings-group-highlight')}>
          <div className="section-title" style={{ marginBottom: 6 }}>
            Обновления
          </div>
          {Capacitor.isNativePlatform() ? (
            <>
              <div className="settings-row">
                <div>
                  <div className="settings-row-title">Проверить обновления</div>
                  <div className="settings-row-desc">Текущая версия {APP_VERSION}</div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="refresh"
                  disabled={update.status === 'checking'}
                  onClick={() => void checkUpdates()}
                >
                  {update.status === 'checking' ? 'Проверка…' : 'Проверить'}
                </Button>
              </div>

              {update.status === 'error' && (
                <div className="limit-banner" style={{ marginTop: 8, marginBottom: 0 }}>
                  <span className="limit-banner-text">{update.message}</span>
                </div>
              )}

              {update.status === 'up-to-date' && (
                <div className="field-hint" style={{ marginTop: 8 }}>
                  У вас установлена последняя версия.
                </div>
              )}

              {update.status === 'available' && (
                <div style={{ marginTop: 10 }}>
                  <div className="settings-row-title" style={{ marginBottom: 4 }}>
                    Доступна версия {update.release.version}
                  </div>
                  {update.release.notes && (
                    <div className="settings-row-desc release-notes">
                      {update.release.notes.slice(0, 1200)}
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    icon="download"
                    disabled={update.busy}
                    onClick={() => void startUpdate(update.release)}
                  >
                    {update.busy
                      ? update.downloaded
                        ? 'Запуск…'
                        : `Скачивание… ${Math.round(update.progress * 100)}%`
                      : update.downloaded
                        ? 'Установить'
                        : 'Скачать и установить'}
                  </Button>
                  {update.error && (
                    <div className="limit-banner" style={{ marginTop: 8, marginBottom: 0 }}>
                      <span className="limit-banner-text">{update.error}</span>
                    </div>
                  )}
                  {update.downloaded && !update.busy && !update.error && (
                    <div className="field-hint" style={{ marginTop: 8 }}>
                      Файл скачан. Если установка не запустилась, нажмите «Установить».
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="settings-row-desc">
              Mini App всегда открывается с последней версией с GitHub Pages — обновлять вручную
              не нужно. Текущая версия {APP_VERSION}.
            </div>
          )}
        </Card>
      </div>

      <Card>
        <div className="settings-row-title">SelfCRM</div>
        <div className="settings-row-desc" style={{ marginTop: 4 }}>
          Версия {APP_VERSION} · Личная CRM · Данные хранятся локально на устройстве
        </div>
      </Card>

      {restore.status !== 'idle' && (
        <Modal
          title={
            restore.status === 'invalid'
              ? 'Файл не подходит'
              : restore.status === 'done'
                ? 'Данные восстановлены'
                : 'Восстановление из копии'
          }
          onClose={closeRestore}
        >
          {restore.status === 'invalid' && (
            <>
              <div className="limit-banner limit-banner-danger" style={{ marginBottom: 0 }}>
                <span className="limit-banner-icon">
                  <Icon name="alert" size={18} />
                </span>
                <span className="limit-banner-text">{restore.message}</span>
              </div>
              <div className="field-hint" style={{ marginTop: 10 }}>
                Файл: {restore.fileName}
              </div>
              <div className="form-actions" style={{ marginTop: 16 }}>
                <Button variant="secondary" onClick={closeRestore}>
                  Понятно
                </Button>
              </div>
            </>
          )}

          {restore.status === 'ready' && (
            <>
              <div className="settings-row-title">{restore.summary.label}</div>
              <div className="settings-row-desc" style={{ marginTop: 4 }}>
                {describeCounts(restore.summary.counts)}
              </div>
              {restore.summary.appVersion !== null && (
                <div className="settings-row-desc">
                  Версия приложения: {restore.summary.appVersion}
                </div>
              )}
              {restore.summary.legacy && (
                <div className="settings-row-desc">
                  Файл старого образца — такие копии SelfCRM тоже понимает
                </div>
              )}
              <div className="field-hint" style={{ marginTop: 10 }}>
                Файл: {restore.fileName}
              </div>

              {willReplace && (
                <div className="limit-banner" style={{ marginTop: 14, marginBottom: 0 }}>
                  <span className="limit-banner-icon">
                    <Icon name="alert" size={18} />
                  </span>
                  <span className="limit-banner-text">
                    Восстановление заменит текущие данные CRM. Перед продолжением рекомендуется
                    создать резервную копию текущих данных.
                  </span>
                </div>
              )}

              {restore.error && (
                <div
                  className="limit-banner limit-banner-danger"
                  style={{ marginTop: 14, marginBottom: 0 }}
                >
                  <span className="limit-banner-icon">
                    <Icon name="alert" size={18} />
                  </span>
                  <span className="limit-banner-text">{restore.error}</span>
                </div>
              )}

              <div className="form-actions" style={{ marginTop: 16 }}>
                <Button variant="secondary" disabled={restore.busy} onClick={closeRestore}>
                  Отмена
                </Button>
                <Button
                  variant="primary"
                  disabled={restore.busy}
                  onClick={() => void runRestore(restore.parsed, willReplace)}
                >
                  {restoreActionLabel}
                </Button>
              </div>
            </>
          )}

          {restore.status === 'done' && (
            <>
              <div className="settings-row-title">CRM восстановлена из резервной копии</div>
              <div className="settings-row-desc" style={{ marginTop: 4 }}>
                {restore.summary.label}
              </div>
              <div className="settings-row-desc">{describeCounts(restore.summary.counts)}</div>
              <div className="form-actions" style={{ marginTop: 16 }}>
                <Button variant="primary" onClick={closeRestore}>
                  Готово
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json,.txt,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleImport(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <input
        ref={addressFileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleAddressImport(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

function ContractorForm() {
  const { db, refresh } = useData()
  const contractor = db.getSettings().contractor ?? emptyContractor()
  const [form, setForm] = useState<Contractor>(contractor)
  const [errors, setErrors] = useState<Partial<Record<keyof Contractor, string>>>({})
  const [saved, setSaved] = useState(false)

  // Поля с масками отдают уже готовую строку, поэтому обработчик общий:
  // заодно снимает ошибку с поля, в которое снова начали вводить.
  const setField = (key: keyof Contractor) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // Реквизиты попадают в чек PDF, поэтому проверяем их длину: пустое значение
  // допустимо, неполное — нет. Телефон проверяется отдельно: если он введён,
  // по нему должны работать звонок и мессенджеры.
  const validate = (): boolean => {
    const found: Partial<Record<keyof Contractor, string>> = {}
    if (!isPhoneValid(form.phone)) found.phone = 'В номере должно быть 10 или 11 цифр'
    if (!hasValidDigitLength(form.inn, INN_LENGTHS)) found.inn = 'ИНН — 10 или 12 цифр'
    if (!hasValidDigitLength(form.ogrn, OGRN_LENGTHS)) found.ogrn = 'ОГРН — 13 или 15 цифр'
    if (!hasValidDigitLength(form.kpp, KPP_LENGTHS)) found.kpp = 'КПП — 9 цифр'
    setErrors(found)
    return Object.keys(found).length === 0
  }

  const save = () => {
    if (!validate()) return
    db.updateSettings({
      contractor: {
        name: form.name.trim(),
        inn: form.inn.trim(),
        ogrn: form.ogrn.trim(),
        kpp: form.kpp.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
      },
    })
    refresh()
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="form">
      <Field label="Название / ФИО">
        <Input
          value={form.name}
          onChange={(e) => setField('name')(e.target.value)}
          placeholder="ИП Иванов Иван Иванович"
        />
      </Field>
      <div className="item-card-row">
        <Field label="ИНН" error={errors.inn} hint="10 или 12 цифр">
          <IntegerInput
            maxDigits={12}
            value={form.inn}
            onChange={setField('inn')}
            placeholder="770000000000"
          />
        </Field>
        <Field label="ОГРН" error={errors.ogrn} hint="13 или 15 цифр">
          <IntegerInput
            maxDigits={15}
            value={form.ogrn}
            onChange={setField('ogrn')}
            placeholder="1234567890123"
          />
        </Field>
      </div>
      <Field label="КПП" error={errors.kpp} hint="9 цифр">
        <IntegerInput maxDigits={9} value={form.kpp} onChange={setField('kpp')} placeholder="770001001" />
      </Field>
      <Field label="Телефон" error={errors.phone} hint="Только цифры и оформление: +7 900 000-00-00">
        <PhoneInput value={form.phone} onChange={setField('phone')} placeholder="+7 900 000-00-00" />
      </Field>
      <Field label="Email">
        <Input
          value={form.email}
          onChange={(e) => setField('email')(e.target.value)}
          type="email"
          placeholder="mail@example.com"
        />
      </Field>
      <Field label="Адрес">
        <Input
          value={form.address}
          onChange={(e) => setField('address')(e.target.value)}
          placeholder="г. Москва, ул. Примерная, д. 1"
        />
      </Field>
      <div className="form-actions">
        <Button variant="primary" icon="check" onClick={save}>
          {saved ? 'Сохранено' : 'Сохранить'}
        </Button>
      </div>
    </div>
  )
}

