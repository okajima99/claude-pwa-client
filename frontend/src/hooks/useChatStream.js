import { useState, useRef, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { API_BASE, AGENTS, MAX_MESSAGES } from '../constants.js'
import { generateId } from '../utils/id.js'
import { fileToBase64 } from '../utils/file.js'
import { formatTool, describeError } from '../utils/format.js'

export function useChatStream({
  activeAgent,
  setMessages,
  input, setInput,
  attachments, clearAttachments,
  scrollToBottom, isAtBottomRef,
}) {
  const [loading, setLoading] = useState({ agent_a: false, agent_b: false })

  const abortControllers = useRef({ agent_a: null, agent_b: null })
  const reconnectingRef = useRef({ agent_a: false, agent_b: false })
  const loadingRef = useRef(loading)

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
  // reconnect中はバブル分割を抑制するフラグ
  const replayModeRef = useRef({ agent_a: false, agent_b: false })

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

  // 受信済み位置(localPos)とサーバーバッファを比較し、遅れていればreconnectを開始する
  // 再接続はfire-and-forget: 呼び出し側は「再接続が走るか」だけ判断し、後続処理を止める
  // reconnectingRef は即時セットされるので、finally内の二重起動防止も効く
  const _reconnectIfBehind = async (agent, localPos) => {
    try {
      const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
      if (!s) return false
      if (s.buffer_id) saveBufId(agent, s.buffer_id)
      if (s.streaming || localPos < (s.buffer_length ?? 0)) {
        reconnectingRef.current[agent] = true
        reconnectStream(agent).finally(() => {
          reconnectingRef.current[agent] = false
        })
        return true
      }
    } catch {}
    return false
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

  // SSEイベントをバッファに積む（sendMessage / reconnectStream 共通）
  const processStreamEvent = (agent, event) => {
    if (event.type !== 'assistant' || !event.message?.content) return
    // サブエージェント内部のイベントはバブル内に表示しない（ActivityBar の subagent チップで状態表示）
    if (event.parent_tool_use_id) return

    const textContent = event.message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
    const thinkingContent = event.message.content
      .filter(b => b.type === 'thinking')
      .map(b => b.thinking)
      .join('\n')
    // Agent（サブエージェント起動）は ActivityBar で表示するため tool-log からは除外
    const newTools = event.message.content
      .filter(b => b.type === 'tool_use' && b.name !== 'Agent')
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

  useEffect(() => { loadingRef.current = loading }, [loading])

  // 処理中ストリームへの再接続チェック（重複防止つき）
  const checkAndReconnect = async (forceReconnect = false) => {
    for (const agent of AGENTS) {
      if (reconnectingRef.current[agent]) continue
      if (!forceReconnect && loadingRef.current[agent]) continue
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json())
        // バッファ世代が変わっていたら既読位置をリセット
        if (s.buffer_id && s.buffer_id !== bufferIdRef.current[agent]) {
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

  // 「最新を取得」ボタン専用: 現バブルをリセットしてサーバーバッファを先頭から再構築する
  // 「思考中に通信が途切れて見えない」ケースで確実に復旧させるための強制replay
  const fetchLatest = async () => {
    const agent = activeAgent
    if (reconnectingRef.current[agent]) return

    // 進行中のfetchがあれば中断
    if (abortControllers.current[agent]) {
      abortControllers.current[agent].abort()
      abortControllers.current[agent] = null
    }

    // サーバーが推論中なら先にloading=trueをセット（送信ボタン→停止ボタン化）
    // これがないと、バッファ空の推論中に「送信」が見えて押せてしまう誤認が出る
    try {
      const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
      if (s?.streaming) {
        setLoading(prev => ({ ...prev, [agent]: true }))
      }
    } catch {}

    // 最後のagentバブルをリセット（replayで再構築するため）
    setMessages(prev => {
      const msgs = [...prev[agent]]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'agent') {
        msgs[msgs.length - 1] = { ...last, text: '', tools: [], thinking: null, streaming: true }
      }
      return { ...prev, [agent]: msgs }
    })

    // バッファ位置を先頭に戻してreconnect
    saveBufPos(agent, 0)
    reconnectingRef.current[agent] = true
    try {
      const hadData = await reconnectStream(agent)
      // 204 (データなし)で戻ってきた場合、サーバーが完了していれば loading を解除
      // 推論中ならloading=trueのまま維持（停止ボタン表示）
      if (!hadData) {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
        if (!s?.streaming) {
          setLoading(prev => ({ ...prev, [agent]: false }))
        }
      }
    } finally {
      reconnectingRef.current[agent] = false
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
      clearAttachments(agent)
      setLoading(prev => ({ ...prev, [agent]: true }))
    })
    // flushSync 後はDOMが確定しているので直接スクロール
    scrollToBottom()

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

      // SSEが静かに切れた場合の復旧: サーバーにまだデータが残っていれば追いかける
      if (await _reconnectIfBehind(agent, localPos)) return
    } catch (e) {
      if (e.name === 'AbortError') return
      const errText = describeError(e)
      // 通信失敗時: reconnectで取り戻せれば続行、ダメならエラー表示
      const recovered = await _reconnectIfBehind(agent, localPos)
      if (!recovered) {
        setMessages(prev => {
          const msgs = prev[agent]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'agent' && (last.text || last.tools?.length > 0)) return prev
          return { ...prev, [agent]: [...msgs, { id: generateId(), role: 'error', text: errText }] }
        })
      }
    } finally {
      cancelAndFlush(agent)
      // reconnectStreamが走っている間は状態を触らない（そちらが最終化する）
      if (reconnectingRef.current[agent]) return
      // post-stream checkが例外で落ちた場合の最終フォールバック
      if (await _reconnectIfBehind(agent, localPos)) return

      saveBufPos(agent, Math.max(bufferPosRef.current[agent], localPos))
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
    await fetch(`${API_BASE}/session/${activeAgent}/end`, { method: 'POST' })
    setMessages(prev => ({
      ...prev,
      [activeAgent]: [...prev[activeAgent], { id: generateId(), role: 'system', text: '--- セッション終了 ---' }],
    }))
  }

  return {
    loading,
    sendMessage,
    stopMessage,
    fetchLatest,
    endSession,
  }
}
