import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense, memo } from 'react'
import { flushSync } from 'react-dom'
import LZString from 'lz-string'
const { compressToUTF16, decompressFromUTF16 } = LZString
import './App.css'
import MessageRenderer from './MessageRenderer.jsx'
const FilePreviewModal = lazy(() => import('./FilePreviewModal.jsx'))
const FileTreePanel = lazy(() => import('./FileTreePanel.jsx'))

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

const AGENTS = ['agent_a', 'agent_b']
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_MESSAGES = 200

const generateId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = reject
  reader.readAsDataURL(file)
})

export default function App() {
  const [activeAgent, setActiveAgent] = useState(() => {
    try {
      const saved = localStorage.getItem('cpc_active_agent')
      return saved && AGENTS.includes(saved) ? saved : 'agent_a'
    } catch {
      return 'agent_a'
    }
  })
  const [messages, setMessages] = useState(() => {
    try {
      const raw = localStorage.getItem('cpc_messages')
      if (raw) {
        const decompressed = decompressFromUTF16(raw)
        const parsed = decompressed ? JSON.parse(decompressed) : JSON.parse(raw)
        // IDがないメッセージに付与（移行対応）
        const result = {}
        for (const agent of AGENTS) {
          result[agent] = (parsed[agent] || []).map(m => m.id ? m : { ...m, id: generateId() })
        }
        return result
      }
    } catch {}
    return { agent_a: [], agent_b: [] }
  })
  const [input, setInput] = useState(() => {
    try {
      const saved = localStorage.getItem('cpc_input')
      return saved ? JSON.parse(saved) : { agent_a: '', agent_b: '' }
    } catch {
      return { agent_a: '', agent_b: '' }
    }
  })
  // attachments: {agent_a: [{file, url}], agent_b: [{file, url}]}
  // urlはファイル追加時に1回だけ生成し、削除時にrevoke
  const [attachments, setAttachments] = useState({ agent_a: [], agent_b: [] })
  const [loading, setLoading] = useState({ agent_a: false, agent_b: false })
  const [status, setStatus] = useState(null)
  const [displayNames, setDisplayNames] = useState({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [previewPath, setPreviewPath] = useState(null)
  const [treeOpen, setTreeOpen] = useState(null)

  const handleOpenPath = useCallback((path) => {
    if (path.endsWith('/')) {
      setTreeOpen(path)
    } else {
      setPreviewPath(path)
    }
  }, [])
  const [confirmEnd, setConfirmEnd] = useState(false)
  // スクロール制御
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  const isAtBottomRef = useRef(true)
  const scrollThrottleRef = useRef(0)
  const scrollerDomRef = useRef(null)
  const msgLengthRef = useRef({ agent_a: 0, agent_b: 0 })
  const menuRef = useRef(null)
  const abortControllers = useRef({ agent_a: null, agent_b: null })
  const fileInputRef = useRef(null)
  const reconnectingRef = useRef({ agent_a: false, agent_b: false })
  const loadingRef = useRef(loading)
  // アンマウント時に未送信添付ファイルのBlobURLを解放するための参照
  const attachmentsRef = useRef(attachments)
  const msgSaveTimer = useRef(null)
  const inputSaveTimer = useRef(null)

  // rAFバッチング用
  const streamBufRef = useRef(null)
  if (streamBufRef.current === null) {
    streamBufRef.current = {}
    for (const a of AGENTS) {
      streamBufRef.current[a] = { text: null, thinking: null, newTools: [], needsNewBubble: false, dirty: false }
    }
  }
  const rafIdRef = useRef({ agent_a: null, agent_b: null })
  const currentBubbleHasToolsRef = useRef({ agent_a: false, agent_b: false })

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
  // バッファ世代ID（エージェントごと）— ズレ検知用
  const bufferIdRef = useRef(null)
  if (bufferIdRef.current === null) {
    try {
      const saved = localStorage.getItem('cpc_bufid')
      bufferIdRef.current = saved ? JSON.parse(saved) : { agent_a: null, agent_b: null }
    } catch {
      bufferIdRef.current = { agent_a: null, agent_b: null }
    }
  }
  const saveBufPos = (agent, pos) => {
    bufferPosRef.current[agent] = pos
    localStorage.setItem('cpc_bufpos', JSON.stringify(bufferPosRef.current))
  }
  const saveBufId = (agent, id) => {
    bufferIdRef.current[agent] = id
    localStorage.setItem('cpc_bufid', JSON.stringify(bufferIdRef.current))
  }
  // ストリーム完了後にサーバーのbuffer_idを同期する
  const syncBufId = async (agent) => {
    try {
      const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json())
      if (s.buffer_id) saveBufId(agent, s.buffer_id)
    } catch {}
  }

  // rAFバッチング: バッファの最新状態をReact stateに1回だけ反映
  const flushStreamBuf = (agent) => {
    const buf = streamBufRef.current[agent]
    if (!buf.dirty) return

    const snap = {
      text: buf.text,
      thinking: buf.thinking,
      newTools: [...buf.newTools],
      needsNewBubble: buf.needsNewBubble,
    }
    buf.text = null
    buf.thinking = null
    buf.newTools = []
    buf.needsNewBubble = false
    buf.dirty = false

    setMessages(prev => {
      const msgs = [...prev[agent]]

      if (snap.needsNewBubble) {
        return { ...prev, [agent]: [...msgs, {
          id: generateId(),
          role: 'agent',
          text: snap.text || '',
          tools: [],
          streaming: true,
        }]}
      }

      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'agent') return prev

      const updated = { ...last }
      if (snap.text !== null) updated.text = snap.text
      if (snap.thinking !== null) updated.thinking = snap.thinking
      if (snap.newTools.length > 0) {
        const existing = updated.tools || []
        const existingIds = new Set(existing.map(t => t.id))
        const toAdd = snap.newTools.filter(t => !existingIds.has(t.id))
        if (toAdd.length > 0) updated.tools = [...existing, ...toAdd]
      }
      msgs[msgs.length - 1] = updated
      return { ...prev, [agent]: msgs }
    })
  }

  const scheduleFlush = (agent) => {
    if (rafIdRef.current[agent] !== null) return
    rafIdRef.current[agent] = requestAnimationFrame(() => {
      rafIdRef.current[agent] = null
      flushStreamBuf(agent)
    })
  }

  const cancelAndFlush = (agent) => {
    if (rafIdRef.current[agent] !== null) {
      cancelAnimationFrame(rafIdRef.current[agent])
      rafIdRef.current[agent] = null
    }
    flushStreamBuf(agent)
  }

  // reconnect中はバブル分割を抑制するフラグ
  const replayModeRef = useRef({ agent_a: false, agent_b: false })

  // SSEイベントをバッファに積む（sendMessage / reconnectStream 共通）
  const processStreamEvent = (agent, event) => {
    if (event.type !== 'assistant' || !event.message?.content) return

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

    const buf = streamBufRef.current[agent]
    // reconnect中は既存バブルに積むだけ（分割すると2重表示になる）
    const needsNewBubble = !replayModeRef.current[agent] && currentBubbleHasToolsRef.current[agent] && textContent && newTools.length === 0

    if (needsNewBubble) {
      buf.needsNewBubble = true
      buf.text = textContent
      buf.thinking = null
      buf.newTools = []
      currentBubbleHasToolsRef.current[agent] = false
    } else {
      if (textContent) buf.text = textContent
      if (thinkingContent) buf.thinking = thinkingContent
      if (newTools.length > 0) {
        buf.newTools = [...buf.newTools, ...newTools]
        currentBubbleHasToolsRef.current[agent] = true
      }
    }
    buf.dirty = true
    scheduleFlush(agent)
  }

  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  useEffect(() => { loadingRef.current = loading }, [loading])

  // アンマウント時に未送信BlobURLを解放
  useEffect(() => {
    return () => {
      for (const agent of AGENTS) {
        for (const item of attachmentsRef.current[agent]) {
          if (item.url) URL.revokeObjectURL(item.url)
        }
      }
    }
  }, [])

  useEffect(() => {
    fetch(`${API_BASE}/agents`).then(r => r.json()).then(agents => {
      const map = {}
      for (const a of agents) map[a.id] = a.display_name
      setDisplayNames(map)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const fetchStatus = async () => {
      if (document.hidden) return
      try {
        const res = await fetch(`${API_BASE}/status/${activeAgent}`)
        if (res.ok) setStatus(await res.json())
      } catch {}
    }
    fetchStatus()
    const id = setInterval(fetchStatus, 30000)
    return () => clearInterval(id)
  }, [activeAgent])

  useEffect(() => {
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current)
    msgSaveTimer.current = setTimeout(() => {
      // localStorageにはimagesのBlobURLは保存できないので除外し、lz-stringで圧縮
      const toSave = {}
      for (const agent of AGENTS) {
        toSave[agent] = messages[agent].slice(-MAX_MESSAGES)
      }
      localStorage.setItem('cpc_messages', compressToUTF16(JSON.stringify(toSave)))
    }, 1000)
  }, [messages])

  useEffect(() => {
    if (inputSaveTimer.current) clearTimeout(inputSaveTimer.current)
    inputSaveTimer.current = setTimeout(() => {
      localStorage.setItem('cpc_input', JSON.stringify(input))
    }, 500)
  }, [input])

  const programmaticScrollRef = useRef(false)
  const scrollEndTimerRef = useRef(null)

  const scrollToBottom = (behavior = 'auto') => {
    const el = scrollerDomRef.current
    if (!el) return
    programmaticScrollRef.current = true
    isAtBottomRef.current = true
    setHasNew(false)
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      // smoothスクロールは数百ms続く。その間にonScrollでisAtBottomRefを書き換えられないよう保持
      clearTimeout(scrollEndTimerRef.current)
      scrollEndTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false
      }, 600)
    } else {
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => { programmaticScrollRef.current = false })
    }
  }

  // 新着メッセージ時の自動スクロール（タブ切り替えは別のuseEffect）
  useEffect(() => {
    const currentLen = messages[activeAgent].length
    const prevLen = msgLengthRef.current[activeAgent]
    msgLengthRef.current[activeAgent] = currentLen

    if (currentLen > prevLen) {
      // 新規アイテム追加: 最下部にいれば追従、そうでなければ未読通知
      if (isAtBottomRef.current) {
        requestAnimationFrame(() => { requestAnimationFrame(() => { scrollToBottom('smooth') }) })
      } else {
        setHasNew(true)
      }
    } else if (isAtBottomRef.current) {
      // ストリーミング中の内容更新（アイテム数変化なし）: autoで即時追従
      scrollToBottom()
    }
  }, [messages, activeAgent])

  // タブ切り替え時は常に最下部へ
  useEffect(() => {
    isAtBottomRef.current = true
    setShowScrollBtn(false)
    setHasNew(false)
    msgLengthRef.current[activeAgent] = messages[activeAgent].length

    const el = scrollerDomRef.current
    if (!el) return
    // 画像onload・markdownハイライト等で後から高さが増えるケースに備え、
    // 500msの窓で scrollHeight 変化を追う（最下部にいる間だけ追従）
    let cancelled = false
    let lastHeight = -1
    const deadline = Date.now() + 500
    const tick = () => {
      if (cancelled) return
      const cur = el.scrollHeight
      if (cur !== lastHeight && isAtBottomRef.current) {
        lastHeight = cur
        scrollToBottom()
      }
      if (Date.now() < deadline) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => { cancelled = true }
  }, [activeAgent])

  // 画面回転時：最下部にいた場合は追従
  useEffect(() => {
    const onResize = () => {
      if (isAtBottomRef.current) scrollToBottom()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 処理中ストリームへの再接続チェック（重複防止つき）
  const checkAndReconnect = async (forceReconnect = false) => {
    for (const agent of AGENTS) {
      if (reconnectingRef.current[agent]) continue
      if (!forceReconnect && loadingRef.current[agent]) continue
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json())
        // バッファ世代が変わっていたら既読位置をリセット
        if (s.buffer_id && s.buffer_id !== bufferIdRef.current[agent]) {
          bufferPosRef.current[agent] = 0
          saveBufId(agent, s.buffer_id)
          saveBufPos(agent, 0)
        }
        const bufPos = bufferPosRef.current[agent] ?? 0
        if (s.streaming || bufPos < (s.buffer_length ?? 0)) {
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

  // アプリ起動時チェック
  useEffect(() => { checkAndReconnect() }, [])

  // オフライン復帰時チェック
  useEffect(() => {
    const handle = () => checkAndReconnect(true)
    window.addEventListener('online', handle)
    return () => window.removeEventListener('online', handle)
  }, [])

  // アプリ復帰時チェック
  useEffect(() => {
    const handle = () => {
      if (!document.hidden) {
        // バックグラウンド中にrAFが止まって未反映のストリームデータがあれば強制反映
        for (const agent of AGENTS) {
          cancelAndFlush(agent)
        }
        checkAndReconnect(true)
        requestAnimationFrame(() => { requestAnimationFrame(() => { scrollToBottom() }) })
      }
    }
    document.addEventListener('visibilitychange', handle)
    return () => document.removeEventListener('visibilitychange', handle)
  }, [])

  const handleFileSelect = (e) => {
    const agent = activeAgent
    const newItems = Array.from(e.target.files || []).map(file => ({
      file,
      url: SUPPORTED_IMAGE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null,
    }))
    setAttachments(prev => ({
      ...prev,
      [agent]: [...prev[agent], ...newItems],
    }))
    e.target.value = ''
  }

  const removeAttachment = (agent, index) => {
    setAttachments(prev => {
      const updated = [...prev[agent]]
      const removed = updated.splice(index, 1)
      if (removed[0]?.url) URL.revokeObjectURL(removed[0].url)
      return { ...prev, [agent]: updated }
    })
  }

  const sendMessage = async () => {
    const agent = activeAgent
    const text = input[agent].trim()
    const items = attachments[agent]
    if (!text && items.length === 0) return
    if (loading[agent]) return

    const imageItems = items.filter(item => item.url)
    const fileNames = items.filter(item => !item.url).map(item => item.file.name)

    // 送信前に base64 変換（リロード後も表示できるよう data URL として保存）
    const imageUrls = (await Promise.all(
      imageItems.map(item => fileToBase64(item.file).catch(() => null))
    )).filter(Boolean)
    // 変換済みなので BlobURL は解放
    imageItems.forEach(item => URL.revokeObjectURL(item.url))

    // flushSync でDOMを確定させてからスクロール（rAF経由だとDOMコミット前に発火してscrollHeightが古い）
    isAtBottomRef.current = true
    const userMsg = { id: generateId(), role: 'user', text, imageUrls, fileNames }
    const agentMsg = { id: generateId(), role: 'agent', text: '', tools: [], streaming: true }
    flushSync(() => {
      setMessages(prev => ({
        ...prev,
        [agent]: [...prev[agent], userMsg, agentMsg].slice(-MAX_MESSAGES),
      }))
      setInput(prev => ({ ...prev, [agent]: '' }))
      setAttachments(prev => ({ ...prev, [agent]: [] }))
      setLoading(prev => ({ ...prev, [agent]: true }))
    })
    // flushSync 後はDOMが確定しているので直接スクロール
    scrollToBottom('smooth')

    const controller = new AbortController()
    abortControllers.current[agent] = controller

    // バッファ初期化
    streamBufRef.current[agent] = { text: null, thinking: null, newTools: [], needsNewBubble: false, dirty: false }
    currentBubbleHasToolsRef.current[agent] = false

    saveBufPos(agent, 0)
    let localPos = 0

    try {
      const formData = new FormData()
      formData.append('message', text)
      for (const item of items) {
        formData.append('files', item.file)
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

          localPos++
          bufferPosRef.current[agent] = localPos

          try {
            processStreamEvent(agent, JSON.parse(data))
          } catch {}
        }
      }

      // ストリームが静かに切れた場合の再接続（処理中 or 未取得バッファあり）
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
        if (s) {
          // POSTレスポンスから直接ストリームしたので、localPosは現在バッファの正しい位置。
          // buffer_idだけ同期し、位置はリセットしない（リセットすると全イベント再送→2重表示）
          if (s.buffer_id) saveBufId(agent, s.buffer_id)
          if (s.streaming || localPos < (s.buffer_length ?? 0)) {
            await reconnectStream(agent)
            return
          }
        }
      } catch {}
    } catch (e) {
      if (e.name === 'AbortError') return
      const errText = describeError(e)
      try {
        const gotData = await reconnectStream(agent)
        if (!gotData) {
          setMessages(prev => {
            const msgs = prev[agent]
            const last = msgs[msgs.length - 1]
            if (last?.role === 'agent' && (last.text || last.tools?.length > 0)) return prev
            return { ...prev, [agent]: [...msgs, { id: generateId(), role: 'error', text: errText }] }
          })
        }
      } catch {
        setMessages(prev => {
          const msgs = prev[agent]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'agent' && (last.text || last.tools?.length > 0)) return prev
          return { ...prev, [agent]: [...msgs, { id: generateId(), role: 'error', text: errText }] }
        })
      }
    } finally {
      cancelAndFlush(agent)
      // reconnectStreamが引き継いだ場合、状態を上書きしない（loading/streaming/bufPosの競合防止）
      if (reconnectingRef.current[agent]) return
      // フォールバック: post-stream checkが失敗してreconnectできなかった場合、ここで再試行
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
        if (s) {
          if (s.buffer_id) saveBufId(agent, s.buffer_id)
          if (s.streaming || localPos < (s.buffer_length ?? 0)) {
            await reconnectStream(agent)
            return
          }
        }
      } catch {}
      bufferPosRef.current[agent] = Math.max(bufferPosRef.current[agent], localPos)
      localStorage.setItem('cpc_bufpos', JSON.stringify(bufferPosRef.current))
      setLoading(prev => ({ ...prev, [agent]: false }))
      setMessages(prev => {
        const msgs = [...prev[agent]]
        if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
        }
        return { ...prev, [agent]: msgs }
      })
      abortControllers.current[agent] = null
      syncBufId(agent)
    }
  }

  // reconnect: 204 なら false、データあり(ストリーミング完了)なら true を返す
  const reconnectStream = async (agent) => {
    const fromPos = bufferPosRef.current[agent] ?? 0
    const res = await fetch(`${API_BASE}/chat/${agent}/reconnect?from=${fromPos}`)
    if (res.status === 204) return false
    if (!res.ok) return false

    isAtBottomRef.current = true
    setLoading(prev => ({ ...prev, [agent]: true }))
    setMessages(prev => {
      const msgs = prev[agent]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'agent') {
        // 完了済み・streaming中どちらでも既存バブルを再利用（新規追加しない）
        const updated = [...msgs]
        updated[updated.length - 1] = { ...last, streaming: true }
        return { ...prev, [agent]: updated }
      }
      return { ...prev, [agent]: [...msgs, { id: generateId(), role: 'agent', text: '', tools: [], streaming: true }].slice(-MAX_MESSAGES) }
    })

    // バッファ初期化（reconnect中はバブル分割を抑制）
    streamBufRef.current[agent] = { text: null, thinking: null, newTools: [], needsNewBubble: false, dirty: false }
    currentBubbleHasToolsRef.current[agent] = false
    replayModeRef.current[agent] = true

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let localPos = fromPos
    let needsReconnect = false
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
          bufferPosRef.current[agent] = localPos

          try {
            processStreamEvent(agent, JSON.parse(data))
          } catch {}
        }
      }

      // ストリームが静かに切れた場合の再接続チェック、完了時にbuffer_idを同期
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
        if (s?.streaming) needsReconnect = true
        if (s?.buffer_id) saveBufId(agent, s.buffer_id)
      } catch {}

      return true
    } finally {
      replayModeRef.current[agent] = false
      cancelAndFlush(agent)
      saveBufPos(agent, localPos)
      setLoading(prev => ({ ...prev, [agent]: false }))
      setMessages(prev => {
        const msgs = [...prev[agent]]
        if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
        }
        return { ...prev, [agent]: msgs }
      })
      requestAnimationFrame(() => { scrollToBottom() })
      if (needsReconnect) setTimeout(() => reconnectStream(agent), 1000)
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
    setConfirmEnd(false)
    await fetch(`${API_BASE}/session/${activeAgent}/end`, { method: 'POST' })
    setMessages(prev => ({
      ...prev,
      [activeAgent]: [...prev[activeAgent], { id: generateId(), role: 'system', text: '--- セッション終了 ---' }],
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

  const currentAttachments = attachments[activeAgent]

  // ローディング中かつストリーミングメッセージがない場合は仮エントリを末尾に追加
  const displayMessages = useMemo(() => {
    const msgs = messages[activeAgent]
    if (loading[activeAgent] && !msgs.some(m => m.streaming)) {
      return [...msgs, { id: '__loading__', role: '__loading__' }]
    }
    return msgs
  }, [messages, loading, activeAgent])

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
          onScroll={() => {
            if (programmaticScrollRef.current) return
            const el = scrollerDomRef.current
            if (!el) return
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
            isAtBottomRef.current = atBottom
            if (atBottom) setHasNew(false)
            // setShowScrollBtnはre-renderを誘発するためthrottle（150ms）
            const now = Date.now()
            if (now - scrollThrottleRef.current >= 150) {
              scrollThrottleRef.current = now
              setShowScrollBtn(!atBottom)
            }
          }}
        >
          {displayMessages.map((msg) => (
            <MessageItem key={msg.id} msg={msg} onOpenFile={handleOpenPath} />
          ))}
        </div>

        {/* ↓ スクロールボタン */}
        {showScrollBtn && (
          <button className="scroll-btn" onClick={() => scrollToBottom('smooth')}>
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
              <button onClick={() => { checkAndReconnect(true); requestAnimationFrame(() => { requestAnimationFrame(() => { scrollToBottom() }) }); setMenuOpen(false) }} className="menu-item">
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
              <button onClick={endSession} className="confirm-btn yes">はい</button>
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

function describeError(e) {
  if (!navigator.onLine) return 'オフライン'
  if (e?.name === 'TimeoutError') return 'タイムアウト'
  if (e instanceof TypeError) return 'ネットワークエラー（サーバーに接続できません）'
  if (e?.message) return `エラー: ${e.message}`
  return '送信失敗'
}

const MessageItem = memo(function MessageItem({ msg, onOpenFile }) {
  if (msg.role === '__loading__') {
    return (
      <div className="message agent">
        <span className="bubble dim">…</span>
      </div>
    )
  }
  return (
    <div className={`message ${msg.role}`}>
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
              <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
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
              {msg.tools.map((t) => (
                <div key={t.id} className={`tool-line tool-${t.name.toLowerCase()}`}>
                  {t.label}
                </div>
              ))}
              {msg.streaming && <div className="tool-line tool-pending">…</div>}
            </div>
          )}
          {msg.text && (
            <span className="bubble">
              <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
            </span>
          )}
        </div>
      ) : (
        <span className="bubble">
          <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
        </span>
      )}
    </div>
  )
})

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
