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
  const abortControllers = useRef({ agent_a: null, agent_b: null })

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

    // ユーザーメッセージを追加
    setMessages(prev => ({
      ...prev,
      [agent]: [...prev[agent], { role: 'user', text }]
    }))
    setInput(prev => ({ ...prev, [agent]: '' }))
    setLoading(prev => ({ ...prev, [agent]: true }))

    // 応答の受け皿となる空メッセージを追加
    setMessages(prev => ({
      ...prev,
      [agent]: [...prev[agent], { role: 'agent', text: '', thinking: '', thinkingOpen: true, streaming: true }]
    }))

    const controller = new AbortController()
    abortControllers.current[agent] = controller

    try {
      const res = await fetch(`${API_BASE}/chat/${agent}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // 未完了の行を次回に持ち越す

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          try {
            const event = JSON.parse(data)

            if (event.type === 'assistant' && event.message?.content) {
              const thinkingText = event.message.content
                .filter(b => b.type === 'thinking')
                .map(b => b.thinking)
                .join('')
              const textContent = event.message.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('')

              setMessages(prev => {
                const msgs = [...prev[agent]]
                const last = { ...msgs[msgs.length - 1] }
                if (thinkingText) last.thinking = thinkingText
                if (textContent) last.text = textContent
                msgs[msgs.length - 1] = last
                return { ...prev, [agent]: msgs }
              })
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages(prev => ({
          ...prev,
          [agent]: [...prev[agent], { role: 'error', text: '送信失敗' }]
        }))
      }
    } finally {
      setLoading(prev => ({ ...prev, [agent]: false }))
      setMessages(prev => {
        const msgs = [...prev[agent]]
        if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
          const last = { ...msgs[msgs.length - 1], streaming: false }
          msgs[msgs.length - 1] = last
        }
        return { ...prev, [agent]: msgs }
      })
      abortControllers.current[agent] = null
    }
  }

  const stopMessage = async () => {
    const agent = activeAgent
    // fetchをAbort
    if (abortControllers.current[agent]) {
      abortControllers.current[agent].abort()
      abortControllers.current[agent] = null
    }
    // サブプロセスをkill
    try {
      await fetch(`${API_BASE}/chat/${agent}/stop`, { method: 'POST' })
    } catch {}
    setLoading(prev => ({ ...prev, [agent]: false }))
  }

  const toggleThinking = (agent, index) => {
    setMessages(prev => {
      const msgs = [...prev[agent]]
      msgs[index] = { ...msgs[index], thinkingOpen: !msgs[index].thinkingOpen }
      return { ...prev, [agent]: msgs }
    })
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
            {msg.role === 'agent' && msg.thinking ? (
              <div className="agent-block">
                <div className="thinking-block">
                  <button
                    className="thinking-toggle"
                    onClick={() => toggleThinking(activeAgent, i)}
                  >
                    {msg.thinkingOpen ? '▼' : '▶'} thinking{msg.streaming ? ' …' : ''}
                  </button>
                  {msg.thinkingOpen && (
                    <div className="thinking-content">{msg.thinking}</div>
                  )}
                </div>
                {msg.text && (
                  <span className="bubble">
                    <MessageRenderer text={msg.text} onOpenFile={setPreviewPath} />
                  </span>
                )}
              </div>
            ) : (
              <span className="bubble">
                <MessageRenderer text={msg.text} onOpenFile={setPreviewPath} />
              </span>
            )}
          </div>
        ))}
        {loading[activeAgent] && !messages[activeAgent].some(m => m.streaming) && (
          <div className="message agent">
            <span className="bubble dim">…</span>
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
          {loading[activeAgent] ? (
            <button onClick={stopMessage} className="stop">■</button>
          ) : (
            <button onClick={sendMessage} disabled={!input[activeAgent].trim()} className="send">
              送信
            </button>
          )}
        </div>
      </div>
      {previewPath && (
        <FilePreviewModal path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
      {treeOpen && (
        <FileTreePanel
          onOpenFile={setPreviewPath}
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
