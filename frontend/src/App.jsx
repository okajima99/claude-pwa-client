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

  return (
    <div className="app">
      {/* ステータスバー */}
      <div className="statusbar">
        {status ? (
          <>
            <span className="model">{status.model}</span>
            <span className={pctClass(status.five_hour_resets_at < Date.now() / 1000 ? 0 : status.five_hour_pct)}>5h {status.five_hour_resets_at < Date.now() / 1000 ? 0 : Math.round(status.five_hour_pct)}% <span className="dim">{timeUntil(status.five_hour_resets_at)}</span></span>
            <span className={pctClass(status.seven_day_pct)}>7d {Math.round(status.seven_day_pct)}%</span>
            <span className={pctClass(status.ctx_pct)}>ctx {Math.round(status.ctx_pct || 0)}%</span>
          </>
        ) : (
          <span className="dim">---</span>
        )}
      </div>

      {/* タブ */}
      <div className="tabs">
        {AGENTS.map(agent => (
          <button
            key={agent}
            className={`tab ${activeAgent === agent ? 'active' : ''}`}
            onClick={() => { setActiveAgent(agent); localStorage.setItem('cpc_active_agent', agent) }}
          >
            {displayNames[agent] || agent.toUpperCase()}
          </button>
        ))}
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
