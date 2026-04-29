import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import './App.css'
import MessageItem from './components/MessageItem.jsx'
import ActivityBar from './components/ActivityBar.jsx'
import StatusBar from './components/StatusBar.jsx'
import TabBar from './components/TabBar.jsx'
import ConfirmDialog from './components/ConfirmDialog.jsx'
import { API_BASE, AGENTS } from './constants.js'
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

  // PWA フォア視聴状態を backend に通知する。visibilitychange の瞬間に
  // POST /push/state を 1 回投げるだけ。ポーリング無し = 通信量ゼロに近い。
  // backend はこれをもとにターン完了通知 (Web Push) を抑止/解除する。
  useEffect(() => {
    const sendState = (visible) => {
      fetch(`${API_BASE}/push/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible }),
        keepalive: true,
      }).catch(() => {})
    }
    sendState(!document.hidden)
    const onVis = () => sendState(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // PWA リセット (Service Worker + Cache Storage を消して強制再読み込み)。
  // iOS のホーム画面 PWA は Safari 経由でデータ削除できないので、アプリ内から
  // 同等のことができるようにする。会話ログ (localStorage) は触らない。
  const [confirmReset, setConfirmReset] = useState(false)

  const handleReset = async () => {
    setConfirmReset(false)
    setMenuOpen(false)
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister().catch(() => {})))
      }
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k).catch(() => {})))
      }
    } catch { /* ignore */ }
    // 強制 reload (キャッシュバスタ付き)。location.reload(true) は仕様廃止なのでクエリで代替
    const u = new URL(window.location.href)
    u.searchParams.set('_r', String(Date.now()))
    window.location.replace(u.toString())
  }

  return (
    <div className="app">
      <StatusBar status={status} nowSec={nowSec} />
      <TabBar
        activeAgent={activeAgent}
        setActiveAgent={setActiveAgent}
        displayNames={displayNames}
        tabBadges={tabBadges}
      />

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
              <button onClick={() => { setMenuOpen(false); setConfirmReset(true) }} className="menu-item">
                リセット (キャッシュ・SW 削除)
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

      <ConfirmDialog
        open={confirmEnd}
        text="セッションを終了しますか？"
        onCancel={() => setConfirmEnd(false)}
        onConfirm={handleEndSession}
      />
      <ConfirmDialog
        open={confirmReset}
        text={
          <>
            本当にリセットしますか？
            <br />
            <span className="dim">キャッシュと Service Worker を削除して再読み込みします。会話ログは消えません。</span>
          </>
        }
        onCancel={() => setConfirmReset(false)}
        onConfirm={handleReset}
      />

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
