import { useState, useEffect, useRef } from 'react'
import './App.css'
import MessageRenderer from './MessageRenderer.jsx'
import FilePreviewModal from './FilePreviewModal.jsx'
import FileTreePanel from './FileTreePanel.jsx'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
const AGENTS = ['agent_a', 'agent_b']
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

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
  const [attachments, setAttachments] = useState({ agent_a: [], agent_b: [] })
  const [loading, setLoading] = useState({ agent_a: false, agent_b: false })
  const [status, setStatus] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [previewPath, setPreviewPath] = useState(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const bottomRef = useRef(null)
  const menuRef = useRef(null)
  const abortControllers = useRef({ agent_a: null, agent_b: null })
  const fileInputRef = useRef(null)
  const reconnectingRef = useRef({ agent_a: false, agent_b: false })

  // バッファ消費済み位置（エージェントごと）— localStorageで永続化してスワイプ切り後も復元
  const bufferPosRef = useRef(null)
  if (bufferPosRef.current === null) {
    try {
      const saved = localStorage.getItem('cpc_bufpos')
      bufferPosRef.current = saved ? JSON.parse(saved) : { agent_a: 0, agent_b: 0 }
    } catch {
      bufferPosRef.current = { agent_a: 0, agent_b: 0 }
    }
  }
  const saveBufPos = (agent, pos) => {
    bufferPosRef.current[agent] = pos
    localStorage.setItem('cpc_bufpos', JSON.stringify(bufferPosRef.current))
  }

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

  useEffect(() => {
    // localStorageにはimagesのBlobURLは保存できないので除外
    const toSave = {}
    for (const agent of AGENTS) {
      toSave[agent] = messages[agent].map(m =>
        m.role === 'user' ? { ...m, imageUrls: undefined } : m
      )
    }
    localStorage.setItem('cpc_messages', JSON.stringify(toSave))
  }, [messages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeAgent])

  // 処理中ストリームへの再接続チェック（重複防止つき）
  // forceReconnect=true の時はloading中でも強制的に既存接続を切って再接続（バックグラウンド復帰時）
  const checkAndReconnect = async (forceReconnect = false) => {
    for (const agent of AGENTS) {
      if (reconnectingRef.current[agent]) continue
      if (!forceReconnect && loading[agent]) continue
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json())
        if (s.streaming) {
          // 既存の接続を切断してから再接続
          if (abortControllers.current[agent]) {
            abortControllers.current[agent].abort()
            abortControllers.current[agent] = null
          }
          reconnectingRef.current[agent] = true
          reconnectStream(agent).finally(() => {
            reconnectingRef.current[agent] = false
          })
        }
      } catch {}
    }
  }

  // アプリ起動時チェック（アプリ切り→再起動でも復帰）
  useEffect(() => { checkAndReconnect() }, [])

  // アプリ復帰時チェック（ホーム画面→戻り）
  // forceReconnect=true: loading中でも強制再接続（バックグラウンドで接続が死んでいる可能性があるため）
  useEffect(() => {
    const handle = () => { if (!document.hidden) checkAndReconnect(true) }
    document.addEventListener('visibilitychange', handle)
    return () => document.removeEventListener('visibilitychange', handle)
  }, [loading])

  const handleFileSelect = (e) => {
    const agent = activeAgent
    const newFiles = Array.from(e.target.files || [])
    setAttachments(prev => ({
      ...prev,
      [agent]: [...prev[agent], ...newFiles],
    }))
    e.target.value = ''
  }

  const removeAttachment = (agent, index) => {
    setAttachments(prev => {
      const updated = [...prev[agent]]
      updated.splice(index, 1)
      return { ...prev, [agent]: updated }
    })
  }

  const sendMessage = async () => {
    const agent = activeAgent
    const text = input[agent].trim()
    const files = attachments[agent]
    if (!text && files.length === 0) return
    if (loading[agent]) return

    // ユーザーメッセージをprewiewつきで追加
    const imageUrls = files
      .filter(f => SUPPORTED_IMAGE_TYPES.includes(f.type))
      .map(f => URL.createObjectURL(f))
    const fileNames = files
      .filter(f => !SUPPORTED_IMAGE_TYPES.includes(f.type))
      .map(f => f.name)

    setMessages(prev => ({
      ...prev,
      [agent]: [...prev[agent], { role: 'user', text, imageUrls, fileNames }],
    }))
    setInput(prev => ({ ...prev, [agent]: '' }))
    setAttachments(prev => ({ ...prev, [agent]: [] }))
    setLoading(prev => ({ ...prev, [agent]: true }))

    // 応答の受け皿
    setMessages(prev => ({
      ...prev,
      [agent]: [...prev[agent], { role: 'agent', text: '', tools: [], streaming: true }],
    }))

    const controller = new AbortController()
    abortControllers.current[agent] = controller

    // 新しいメッセージ開始 → サーバー側バッファもリセットされるのでpos初期化
    saveBufPos(agent, 0)
    let localPos = 0

    try {
      const formData = new FormData()
      formData.append('message', text)
      for (const f of files) {
        formData.append('files', f)
      }

      const res = await fetch(`${API_BASE}/chat/${agent}/stream`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          // 受信するたびに位置を更新（切断時に再開できるように）
          localPos++
          saveBufPos(agent, localPos)

          try {
            const event = JSON.parse(data)

            if (event.type === 'assistant' && event.message?.content) {
              const textContent = event.message.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('')
              const thinkingContent = event.message.content
                .filter(b => b.type === 'thinking')
                .map(b => b.thinking)
                .join('\n')
              const newTools = event.message.content
                .filter(b => b.type === 'tool_use')
                .map(b => formatTool(b))

              setMessages(prev => {
                const msgs = [...prev[agent]]
                const last = { ...msgs[msgs.length - 1] }
                if (textContent) last.text = textContent
                if (thinkingContent) last.thinking = thinkingContent
                if (newTools.length > 0) {
                  const existing = last.tools || []
                  const existingIds = new Set(existing.map(t => t.id))
                  const toAdd = newTools.filter(t => !existingIds.has(t.id))
                  if (toAdd.length > 0) last.tools = [...existing, ...toAdd]
                }
                msgs[msgs.length - 1] = last
                return { ...prev, [agent]: msgs }
              })
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return
      // バックグラウンドで処理中なら自動再接続、そうでなければ送信失敗
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json())
        if (s.streaming) {
          reconnectStream(agent)
          return
        }
      } catch {}
      setMessages(prev => ({
        ...prev,
        [agent]: [...prev[agent], { role: 'error', text: '送信失敗' }],
      }))
    } finally {
      setLoading(prev => ({ ...prev, [agent]: false }))
      setMessages(prev => {
        const msgs = [...prev[agent]]
        if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
        }
        return { ...prev, [agent]: msgs }
      })
      abortControllers.current[agent] = null
    }
  }

  const reconnectStream = async (agent) => {
    // 既読位置以降だけ受け取る（バックグラウンド中に進んだ分 or 初回から）
    const fromPos = bufferPosRef.current[agent] ?? 0
    const res = await fetch(`${API_BASE}/chat/${agent}/reconnect?from=${fromPos}`)
    if (res.status === 204) return  // 処理中なし

    setLoading(prev => ({ ...prev, [agent]: true }))
    // 受け皿を追加（ストリーミング中に表示を更新するため）
    setMessages(prev => {
      const msgs = prev[agent]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'agent' && last?.streaming) return prev
      return { ...prev, [agent]: [...msgs, { role: 'agent', text: '', tools: [], streaming: true }] }
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let localPos = fromPos
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          localPos++
          saveBufPos(agent, localPos)

          try {
            const event = JSON.parse(data)
            if (event.type === 'assistant' && event.message?.content) {
              const textContent = event.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
              const thinkingContent = event.message.content.filter(b => b.type === 'thinking').map(b => b.thinking).join('\n')
              const newTools = event.message.content.filter(b => b.type === 'tool_use').map(b => formatTool(b))
              setMessages(prev => {
                const msgs = [...prev[agent]]
                const last = msgs[msgs.length - 1]
                if (!last || last.role !== 'agent') {
                  return { ...prev, [agent]: [...msgs, { role: 'agent', text: textContent, tools: newTools, thinking: thinkingContent || undefined, streaming: true }] }
                }
                const updated = { ...last }
                if (textContent) updated.text = textContent
                if (thinkingContent) updated.thinking = thinkingContent
                if (newTools.length > 0) {
                  const existing = updated.tools || []
                  const existingIds = new Set(existing.map(t => t.id))
                  const toAdd = newTools.filter(t => !existingIds.has(t.id))
                  if (toAdd.length > 0) updated.tools = [...existing, ...toAdd]
                }
                msgs[msgs.length - 1] = updated
                return { ...prev, [agent]: msgs }
              })
            }
          } catch {}
        }
      }
    } finally {
      setLoading(prev => ({ ...prev, [agent]: false }))
      setMessages(prev => {
        const msgs = [...prev[agent]]
        if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
        }
        return { ...prev, [agent]: msgs }
      })
    }
  }

  const stopMessage = async () => {
    const agent = activeAgent
    if (abortControllers.current[agent]) {
      abortControllers.current[agent].abort()
      abortControllers.current[agent] = null
    }
    try {
      await fetch(`${API_BASE}/chat/${agent}/stop`, { method: 'POST' })
    } catch {}
    setLoading(prev => ({ ...prev, [agent]: false }))
  }

  const endSession = async () => {
    setMenuOpen(false)
    await fetch(`${API_BASE}/session/${activeAgent}/end`, { method: 'POST' })
    setMessages(prev => ({
      ...prev,
      [activeAgent]: [...prev[activeAgent], { role: 'system', text: '--- セッション終了 ---' }],
    }))
  }

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

  const currentAttachments = attachments[activeAgent]

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
            {msg.role === 'user' && (msg.imageUrls?.length > 0 || msg.fileNames?.length > 0) ? (
              <div className="user-block">
                {msg.imageUrls?.length > 0 && (
                  <div className="attach-images">
                    {msg.imageUrls.map((url, j) => (
                      <img key={j} src={url} className="msg-image" alt="" />
                    ))}
                  </div>
                )}
                {msg.fileNames?.length > 0 && (
                  <div className="attach-files">
                    {msg.fileNames.map((name, j) => (
                      <span key={j} className="file-chip">📄 {name}</span>
                    ))}
                  </div>
                )}
                {msg.text && (
                  <span className="bubble">
                    <MessageRenderer text={msg.text} onOpenFile={setPreviewPath} />
                  </span>
                )}
              </div>
            ) : msg.role === 'agent' && (msg.tools?.length > 0 || msg.thinking) ? (
              <div className="agent-block">
                {msg.thinking && (
                  <details className="thinking-block">
                    <summary>💭 thinking</summary>
                    <pre className="thinking-text">{msg.thinking}</pre>
                  </details>
                )}
                {msg.tools?.length > 0 && (
                  <div className="tool-log">
                    {msg.tools.map((t, ti) => (
                      <div key={ti} className={`tool-line tool-${t.name.toLowerCase()}`}>
                        {t.label}
                      </div>
                    ))}
                    {msg.streaming && <div className="tool-line tool-pending">…</div>}
                  </div>
                )}
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

      {/* 添付ファイルプレビュー */}
      {currentAttachments.length > 0 && (
        <div className="attachments-bar">
          {currentAttachments.map((f, i) => (
            <div key={i} className="attach-chip">
              {SUPPORTED_IMAGE_TYPES.includes(f.type) ? (
                <img src={URL.createObjectURL(f)} className="attach-thumb" alt="" />
              ) : (
                <span className="attach-name">📄 {f.name}</span>
              )}
              <button className="attach-remove" onClick={() => removeAttachment(activeAgent, i)}>×</button>
            </div>
          ))}
        </div>
      )}

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
          onKeyDown={handleKeyDown}
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

function formatTool(block) {
  const { id, name, input } = block
  let label = ''
  switch (name) {
    case 'Bash':
      label = `$ ${input?.command ?? ''}`
      break
    case 'Read':
      label = `read  ${input?.file_path ?? ''}`
      break
    case 'Write':
      label = `write ${input?.file_path ?? ''}`
      break
    case 'Edit':
      label = `edit  ${input?.file_path ?? ''}`
      break
    case 'Glob':
      label = `glob  ${input?.pattern ?? ''}`
      break
    case 'Grep':
      label = `grep  ${input?.pattern ?? ''}`
      break
    default:
      label = `[${name}] ${JSON.stringify(input ?? {})}`
  }
  return { id, name, label }
}

function pctClass(pct) {
  if (pct >= 80) return 'pct red'
  if (pct >= 50) return 'pct yellow'
  return 'pct green'
}

function timeUntil(unixSec) {
  const now = Date.now() / 1000
  let resetAt = unixSec
  if (resetAt < now) {
    const periods = Math.ceil((now - resetAt) / (5 * 3600))
    resetAt += periods * 5 * 3600
  }
  const diff = Math.max(0, resetAt - now)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}
