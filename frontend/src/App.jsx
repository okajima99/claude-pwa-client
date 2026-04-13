import { useState, useEffect, useRef } from 'react'
import './App.css'
import MessageRenderer from './MessageRenderer.jsx'
import FilePreviewModal from './FilePreviewModal.jsx'
import FileTreePanel from './FileTreePanel.jsx'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
const AGENTS = ['agent_a', 'agent_b']

export default function App() {
  const [activeAgent, setActiveAgent] = useState('agent_a')
  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem('cpc_messages')
      return saved ? JSON.parse(saved) : { agent_a: [], agent_b: [] }
    } catch {
      return { agent_a: [], agent_b: [] }
    }
  })
  const [input, setInput] = useState({ agent_a: '', agent_b: '' })
  const [loading, setLoading] = useState({ agent_a: false, agent_b: false })
  const [status, setStatus] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [previewPath, setPreviewPath] = useState(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const bottomRef = useRef(null)
  const menuRef = useRef(null)

  // タブ切り替え・10秒ごとにステータス取得
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/status/${activeAgent}`)
        if (res.ok) setStatus(await res.json())
      } catch {}
    }
    fetchStatus()
    const id = setInterval(fetchStatus, 10000)
    return () => clearInterval(id)
  }, [activeAgent])

  // メッセージ履歴をlocalStorageに保存
  useEffect(() => {
    localStorage.setItem('cpc_messages', JSON.stringify(messages))
  }, [messages])

  // 新しいメッセージで自動スクロール
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeAgent])

  const sendMessage = async () => {
    const agent = activeAgent
    const text = input[agent].trim()
    if (!text || loading[agent]) return

    setMessages(prev => ({
      ...prev,
      [agent]: [...prev[agent], { role: 'user', text }]
    }))
    setInput(prev => ({ ...prev, [agent]: '' }))
    setLoading(prev => ({ ...prev, [agent]: true }))

    try {
      const res = await fetch(`${API_BASE}/chat/${agent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      setMessages(prev => ({
        ...prev,
        [agent]: [...prev[agent], { role: 'agent', text: data.result }]
      }))
    } catch {
      setMessages(prev => ({
        ...prev,
        [agent]: [...prev[agent], { role: 'error', text: '送信失敗' }]
      }))
    } finally {
      setLoading(prev => ({ ...prev, [agent]: false }))
    }
  }

  const endSession = async () => {
    setMenuOpen(false)
    await fetch(`${API_BASE}/session/${activeAgent}/end`, { method: 'POST' })
    setMessages(prev => ({
      ...prev,
      [activeAgent]: [...prev[activeAgent], { role: 'system', text: '--- セッション終了 ---' }]
    }))
  }

  // メニュー外タップで閉じる
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="app">
      {/* ステータスバー */}
      <div className="statusbar">
        {status ? (
          <>
            <span className="model">{status.model}</span>
            <span className={pctClass(status.five_hour_pct)}>5h {Math.round(status.five_hour_pct)}% <span className="dim">{timeUntil(status.five_hour_resets_at)}</span></span>
            <span className={pctClass(status.seven_day_pct)}>7d {Math.round(status.seven_day_pct)}%</span>
            <span className={pctClass(status.context_pct)}>ctx {Math.round(status.context_pct)}%</span>
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
            onClick={() => setActiveAgent(agent)}
          >
            {agent.toUpperCase()}
          </button>
        ))}
      </div>

      {/* メッセージ一覧 */}
      <div className="messages">
        {messages[activeAgent].map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <span className="bubble">
              <MessageRenderer text={msg.text} onOpenFile={setPreviewPath} />
            </span>
          </div>
        ))}
        {loading[activeAgent] && (
          <div className="message agent">
            <span className="bubble dim">...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 入力エリア */}
      <div className="inputarea">
        <textarea
          value={input[activeAgent]}
          onChange={e => setInput(prev => ({ ...prev, [activeAgent]: e.target.value }))}
          onKeyDown={handleKeyDown}
          placeholder="メッセージを入力..."
          rows={2}
          disabled={loading[activeAgent]}
        />
        <div className="buttons" ref={menuRef}>
          {menuOpen && (
            <div className="action-menu">
              <button onClick={() => { setTreeOpen(true); setMenuOpen(false) }} className="menu-item">
                ファイルツリー
              </button>
              <button onClick={endSession} className="menu-item end">
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
          <button onClick={sendMessage} disabled={loading[activeAgent] || !input[activeAgent].trim()} className="send">
            送信
          </button>
        </div>
      </div>
      {previewPath && (
        <FilePreviewModal path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
      {treeOpen && (
        <FileTreePanel
          onOpenFile={(path) => { setPreviewPath(path) }}
          onClose={() => setTreeOpen(false)}
        />
      )}
    </div>
  )
}

function pctClass(pct) {
  if (pct >= 80) return 'pct red'
  if (pct >= 50) return 'pct yellow'
  return 'pct green'
}

function timeUntil(unixSec) {
  const diff = Math.max(0, unixSec - Date.now() / 1000)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}
