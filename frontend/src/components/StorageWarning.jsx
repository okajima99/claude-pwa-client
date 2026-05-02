// localStorage / IndexedDB / cache 等の合計使用率が高い時に出す警告バナー。
// しきい値: 85% で表示。 タップで隠せる (セッション中だけ)。
const WARN_RATIO = 0.85

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

export default function StorageWarning({ info, dismissed, onDismiss }) {
  if (!info || dismissed) return null
  if (info.ratio < WARN_RATIO) return null
  const pct = Math.round(info.ratio * 100)
  return (
    <div className="storage-warn">
      <span className="storage-warn-icon">⚠</span>
      <span className="storage-warn-text">
        ストレージ使用率 {pct}% ({fmtMB(info.usage)} / {fmtMB(info.quota)})
        <span className="storage-warn-hint">不要なセッションを削除すると解消します</span>
      </span>
      <button className="storage-warn-close" onClick={onDismiss} aria-label="閉じる">×</button>
    </div>
  )
}
