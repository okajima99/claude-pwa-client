// シンプルな yes/no 確認ダイアログ。背景クリックで cancel 扱い。
export default function ConfirmDialog({ open, text, onCancel, onConfirm }) {
  if (!open) return null
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <p className="confirm-text">{text}</p>
        <div className="confirm-actions">
          <button onClick={onCancel} className="confirm-btn no">いいえ</button>
          <button onClick={onConfirm} className="confirm-btn yes">はい</button>
        </div>
      </div>
    </div>
  )
}
