import { useEffect, useRef, useState } from 'react'

// 左サイドからスライドインするセッション一覧ドロワー (ChatGPT 風)。
// - 上部: 「+ 新規セッション」 → agent を選ぶ → createSession
// - リスト: セッション項目をタップで activeSession 切替、 ⋯ メニューでリネーム / 削除
// - badges: pending(?)、 processing(●青)、 new(●赤) を項目右に表示
//
// props:
//   open                : ドロワーが開いてるか
//   onClose             : 閉じる callback
//   sessions            : [{id, agent_id, title, created_at}, ...]
//   agents              : [{id, display_name}, ...] (作成時の選択肢)
//   activeId            : 現在 active な session_id
//   onSelect(sid)       : 切替
//   onCreate(agentId)   : 新規作成
//   onRename(sid, t)    : リネーム
//   onDelete(sid)       : 削除 (確認ダイアログ表示は呼出側責任)
//   sessionBadges       : {sid: {kind, label} | null}
export default function SessionDrawer({
  open,
  onClose,
  sessions,
  agents,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  sessionBadges = {},
}) {
  const [agentPicker, setAgentPicker] = useState(false) // + ボタン押下後の agent 選択メニュー
  const [menuFor, setMenuFor] = useState(null)          // ⋯ メニュー出してる session_id
  const [renameFor, setRenameFor] = useState(null)      // リネーム inline 編集中の session_id
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef(null)

  useEffect(() => {
    if (renameFor && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renameFor])

  // ドロワー閉じる時にメニュー類もクリア
  useEffect(() => {
    if (!open) {
      setAgentPicker(false)
      setMenuFor(null)
      setRenameFor(null)
    }
  }, [open])

  const handleCreate = (agentId) => {
    setAgentPicker(false)
    onCreate(agentId)
    onClose()
  }

  const handleSelect = (sid) => {
    if (renameFor) return // リネーム中は切替させない
    onSelect(sid)
    onClose()
  }

  const startRename = (sid, currentTitle) => {
    setMenuFor(null)
    setRenameFor(sid)
    setRenameValue(currentTitle || '')
  }

  const commitRename = () => {
    if (renameFor) {
      const t = renameValue.trim()
      if (t) onRename(renameFor, t)
    }
    setRenameFor(null)
  }

  return (
    <>
      {open && <div className="drawer-overlay" onClick={onClose} />}
      <aside className={`drawer ${open ? 'open' : ''}`}>
        <div className="drawer-header">
          <span className="drawer-title">セッション</span>
          <button className="drawer-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        <div className="drawer-create">
          {!agentPicker ? (
            <button className="drawer-new" onClick={() => setAgentPicker(true)}>
              + 新規セッション
            </button>
          ) : (
            <div className="agent-picker">
              <div className="agent-picker-label">agent を選択:</div>
              {agents.map(a => (
                <button
                  key={a.id}
                  className="agent-picker-item"
                  onClick={() => handleCreate(a.id)}
                >
                  {a.display_name}
                </button>
              ))}
              <button className="agent-picker-cancel" onClick={() => setAgentPicker(false)}>
                キャンセル
              </button>
            </div>
          )}
        </div>

        <div className="drawer-list">
          {sessions.length === 0 && (
            <div className="drawer-empty">セッションがありません。 上の「+ 新規セッション」 から作成してください。</div>
          )}
          {sessions.map(s => {
            const badge = sessionBadges[s.id]
            const isActive = s.id === activeId
            const isMenuOpen = menuFor === s.id
            const isRenaming = renameFor === s.id
            return (
              <div
                key={s.id}
                className={`drawer-item ${isActive ? 'active' : ''}`}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="drawer-rename-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      else if (e.key === 'Escape') setRenameFor(null)
                    }}
                  />
                ) : (
                  <button
                    className="drawer-item-main"
                    onClick={() => handleSelect(s.id)}
                  >
                    <span className="drawer-item-title">{s.title}</span>
                    {badge && <span className={`tab-badge ${badge.kind}`}>{badge.label}</span>}
                  </button>
                )}

                {!isRenaming && (
                  <button
                    className="drawer-item-menu"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuFor(isMenuOpen ? null : s.id)
                    }}
                    aria-label="メニュー"
                  >
                    ⋯
                  </button>
                )}

                {isMenuOpen && (
                  <div className="drawer-item-popup" onClick={e => e.stopPropagation()}>
                    <button onClick={() => startRename(s.id, s.title)}>リネーム</button>
                    <button
                      className="danger"
                      onClick={() => {
                        setMenuFor(null)
                        onDelete(s.id)
                      }}
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>
    </>
  )
}
