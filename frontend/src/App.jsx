import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import './App.css'
import MessageItem from './components/MessageItem.jsx'
import ActivityBar from './components/ActivityBar.jsx'
import { API_BASE, AGENTS } from './constants.js'
import { pctClass, timeUntil } from './utils/format.js'
import { useStatus } from './hooks/useStatus.js'
import { useAttachments } from './hooks/useAttachments.js'
import { useChatStorage } from './hooks/useChatStorage.js'
import { useAutoScroll } from './hooks/useAutoScroll.js'
import { useChatStream } from './hooks/useChatStream.js'
import { enablePush, disablePush, isPushSupported, isStandalone, isPushEnabledLocally } from './utils/push.js'
const FilePreviewModal = lazy(() => import('./FilePreviewModal.jsx'))
const FileTreePanel = lazy(() => import('./FileTreePanel.jsx'))

export default function App() {
  const [activeAgent, setActiveAgent] = useState(() => {
    try {
      const saved = localStorage.getItem('cpc_active_agent')
      return saved && AGENTS.includes(saved) ? saved : 'agent_a'
    } catch {
      return 'agent_a'
    }
  })

  const { messages, setMessages, input, setInput } = useChatStorage()
  const { attachments, fileInputRef, handleFileSelect, removeAttachment, clearAttachments } = useAttachments(activeAgent)
  const status = useStatus(activeAgent)
  const {
    scrollerDomRef,
    isAtBottomRef,
    showScrollBtn,
    hasNew,
    scrollToBottom,
    onScroll,
  } = useAutoScroll({ messages, activeAgent })
  const { loading, apiKeySource, sendMessage, sendAnswer, stopMessage, fetchLatest, endSession } = useChatStream({
    activeAgent,
    setMessages,
    input, setInput,
    attachments, clearAttachments,
    scrollToBottom, isAtBottomRef,
  })

  const [displayNames, setDisplayNames] = useState({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [previewPath, setPreviewPath] = useState(null)
  const [treeOpen, setTreeOpen] = useState(null)
  const [confirmEnd, setConfirmEnd] = useState(false)
  // 非アクティブタブで messages 増加 or loading 完了が起きたら「新着」
  const [tabHasNew, setTabHasNew] = useState(() => Object.fromEntries(AGENTS.map(a => [a, false])))
  // ステータスバーの相対時刻表示用に30秒間隔でtickする秒値
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30000)
    return () => clearInterval(id)
  }, [])
  const prevTabStateRef = useRef(null)
  const menuRef = useRef(null)

  const handleOpenPath = useCallback((path) => {
    if (path.endsWith('/')) {
      setTreeOpen(path)
    } else {
      setPreviewPath(path)
    }
  }, [])

  const handleAnswer = useCallback((tool_use_id, answer) => {
    sendAnswer(activeAgent, tool_use_id, answer)
  }, [sendAnswer, activeAgent])

  useEffect(() => {
    fetch(`${API_BASE}/agents`).then(r => r.json()).then(agents => {
      const map = {}
      for (const a of agents) map[a.id] = a.display_name
      setDisplayNames(map)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const currentAttachments = attachments[activeAgent]

  // 非アクティブタブの状態遷移を監視して「新着」フラグを立てる:
  //   - messages 件数の増加（新規バブル追加）
  //   - loading の true→false 遷移（既存 streaming バブルの完了）
  // アクティブタブに切り替わったらクリア
  useEffect(() => {
    if (prevTabStateRef.current === null) {
      prevTabStateRef.current = Object.fromEntries(AGENTS.map(a => [a, { len: messages[a].length, loading: !!loading[a] }]))
      return
    }
    // 1) 前回値を読んで遷移を判定
    const transitions = {}
    for (const a of AGENTS) {
      const p = prevTabStateRef.current[a]
      const len = messages[a].length
      const isLoading = !!loading[a]
      transitions[a] = {
        lengthGrew: len > p.len,
        loadingFinished: p.loading && !isLoading,
      }
    }
    // 2) 前回値を更新（副作用は setState の外で行う）
    for (const a of AGENTS) {
      prevTabStateRef.current[a] = { len: messages[a].length, loading: !!loading[a] }
    }
    // 3) フラグ更新
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabHasNew(prev => {
      let changed = false
      const next = { ...prev }
      for (const a of AGENTS) {
        if (a === activeAgent) {
          if (next[a]) { next[a] = false; changed = true }
        } else {
          const t = transitions[a]
          if ((t.lengthGrew || t.loadingFinished) && !next[a]) {
            next[a] = true; changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [messages, loading, activeAgent])

  // タブごとのバッジ判定。アクティブタブは常に非表示。優先度: pending(?) > processing(●青) > new(●赤)
  const tabBadges = useMemo(() => {
    const out = {}
    for (const a of AGENTS) {
      if (a === activeAgent) { out[a] = null; continue }
      const pending = messages[a].some(m => m.askUserQuestion && !m.askUserQuestion.answered)
      if (pending) { out[a] = { kind: 'pending', label: '?' }; continue }
      if (loading[a]) { out[a] = { kind: 'processing', label: '●' }; continue }
      if (tabHasNew[a]) { out[a] = { kind: 'new', label: '●' }; continue }
      out[a] = null
    }
    return out
  }, [messages, loading, tabHasNew, activeAgent])

  // ローディング中かつストリーミングメッセージがない場合は仮エントリを末尾に追加
  const displayMessages = useMemo(() => {
    const msgs = messages[activeAgent]
    if (loading[activeAgent] && !msgs.some(m => m.streaming)) {
      return [...msgs, { id: '__loading__', role: '__loading__' }]
    }
    return msgs
  }, [messages, loading, activeAgent])

  const handleEndSession = () => {
    setMenuOpen(false)
    setConfirmEnd(false)
    endSession()
  }

  // Web Push 通知 ON/OFF
  const [pushEnabled, setPushEnabled] = useState(() => isPushEnabledLocally())
  const [pushBusy, setPushBusy] = useState(false)
  const pushAvailable = isPushSupported() && isStandalone()

  const handleTogglePush = async () => {
    if (pushBusy) return
    setPushBusy(true)
    setMenuOpen(false)
    try {
      if (pushEnabled) {
        await disablePush()
        setPushEnabled(false)
      } else {
        await enablePush()
        setPushEnabled(true)
      }
    } catch (e) {
      alert(e?.message || '通知設定の変更に失敗しました')
    } finally {
      setPushBusy(false)
    }
  }

  return (
    <div className="app">
      {/* ステータスバー */}
      <div className="statusbar">
        {status ? (
          <>
            <span className="model">{status.model}</span>
            {(() => {
              // resets_at が未知 (0) の間は生の pct を信用する。
              // 既知かつ過去の時刻になった時だけ「ウィンドウが切れた」= 0% と解釈する。
              const expired = status.five_hour_resets_at > 0 && status.five_hour_resets_at < nowSec
              const pct = expired ? 0 : status.five_hour_pct
              return (
                <span className={pctClass(pct)}>5h {Math.round(pct)}% <span className="dim">{timeUntil(status.five_hour_resets_at, nowSec)}</span></span>
              )
            })()}
            <span className={pctClass(status.seven_day_pct)}>7d {Math.round(status.seven_day_pct)}%</span>
            <span className={pctClass(status.ctx_pct)}>ctx {Math.round(status.ctx_pct || 0)}%</span>
          </>
        ) : (
          <span className="dim">---</span>
        )}
      </div>

      {/* タブ */}
      <div className="tabs">
        {AGENTS.map(agent => {
          const badge = tabBadges[agent]
          return (
            <button
              key={agent}
              className={`tab ${activeAgent === agent ? 'active' : ''}`}
              onClick={() => { setActiveAgent(agent); localStorage.setItem('cpc_active_agent', agent) }}
            >
              {displayNames[agent] || agent.toUpperCase()}
              {badge && <span className={`tab-badge ${badge.kind}`}>{badge.label}</span>}
            </button>
          )
        })}
      </div>

      {/* メッセージ一覧 */}
      <div className="messages-container">
        <div
          ref={scrollerDomRef}
          className="messages"
          onScroll={onScroll}
        >
          {displayMessages.map((msg) => (
            <MessageItem
              key={msg.id}
              msg={msg}
              onOpenFile={handleOpenPath}
              onAnswer={handleAnswer}
              apiKeySource={apiKeySource[activeAgent]}
            />
          ))}
        </div>

        {/* ↓ スクロールボタン */}
        {showScrollBtn && (
          <button className="scroll-btn" onClick={() => scrollToBottom()}>
            ↓
            {hasNew && <span className="scroll-dot" />}
          </button>
        )}
      </div>

      {/* 添付ファイルプレビュー */}
      {currentAttachments.length > 0 && (
        <div className="attachments-bar">
          {currentAttachments.map((item, i) => (
            <div key={i} className="attach-chip">
              {item.url ? (
                <img src={item.url} className="attach-thumb" alt="" />
              ) : (
                <span className="attach-name">📄 {item.file.name}</span>
              )}
              <button className="attach-remove" onClick={() => removeAttachment(activeAgent, i)}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* アクティビティバー（plan/tool/subagent/todos） */}
      <ActivityBar status={status} />

      {/* 入力エリア */}
      <div className="inputarea">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp,text/*,.py,.js,.ts,.jsx,.tsx,.md,.json,.css,.html,.yaml,.yml,.toml,.sh"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <textarea
          value={input[activeAgent]}
          onChange={e => setInput(prev => ({ ...prev, [activeAgent]: e.target.value }))}
          placeholder="メッセージを入力..."
          rows={2}
          disabled={loading[activeAgent]}
        />
        <div className="buttons" ref={menuRef}>
          {menuOpen && (
            <div className="action-menu">
              <button onClick={() => { fileInputRef.current?.click(); setMenuOpen(false) }} className="menu-item">
                ファイル添付
              </button>
              <button onClick={() => { setTreeOpen('~'); setMenuOpen(false) }} className="menu-item">
                ファイルツリー
              </button>
              <button onClick={() => { fetchLatest(); requestAnimationFrame(() => { requestAnimationFrame(() => { scrollToBottom() }) }); setMenuOpen(false) }} className="menu-item">
                最新を取得
              </button>
              {pushAvailable && (
                <button onClick={handleTogglePush} className="menu-item" disabled={pushBusy}>
                  {pushEnabled ? '通知を無効にする' : '通知を有効にする'}
                </button>
              )}
              <button onClick={() => { setMenuOpen(false); setConfirmEnd(true) }} className="menu-item end">
                セッション終了
              </button>
            </div>
          )}
          <button
            onClick={() => setMenuOpen(prev => !prev)}
            className={`more ${menuOpen ? 'active' : ''}`}
          >
            ⋯
          </button>
          {loading[activeAgent] ? (
            <button onClick={stopMessage} className="stop">■</button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input[activeAgent].trim() && currentAttachments.length === 0}
              className="send"
            >
              送信
            </button>
          )}
        </div>
      </div>

      {confirmEnd && (
        <div className="confirm-overlay" onClick={() => setConfirmEnd(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <p className="confirm-text">セッションを終了しますか？</p>
            <div className="confirm-actions">
              <button onClick={() => setConfirmEnd(false)} className="confirm-btn no">いいえ</button>
              <button onClick={handleEndSession} className="confirm-btn yes">はい</button>
            </div>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        {previewPath && (
          <FilePreviewModal path={previewPath} onClose={() => setPreviewPath(null)} />
        )}
        {treeOpen && (
          <FileTreePanel
            initialPath={treeOpen}
            onOpenFile={handleOpenPath}
            onClose={() => setTreeOpen(null)}
          />
        )}
      </Suspense>
    </div>
  )
}
