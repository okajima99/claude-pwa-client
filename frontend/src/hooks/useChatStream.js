import { useState, useRef, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { API_BASE, MAX_MESSAGES } from '../constants.js'
import { generateId } from '../utils/id.js'
import { fileToBase64 } from '../utils/file.js'
import { describeError } from '../utils/format.js'
import { useStreamBuffer } from './internal/useStreamBuffer.js'
import { useStreamReconnect } from './internal/useStreamReconnect.js'
import { processStreamEvent } from './internal/processStreamEvent.js'

// チャット 1 ターンの送受信・再接続・状態管理を束ねた公開フック。
// セッション (= UI 上のタブ) を session_id (sid) で識別する。
export function useChatStream({
  activeSession,
  sessions,
  setMessages,
  input, setInput,
  attachments, clearAttachments,
  scrollToBottom, isAtBottomRef,
}) {
  // loading / apiKeySource は session_id をキーに動的に増減する dict
  const [loading, setLoading] = useState({})
  const [apiKeySource, setApiKeySource] = useState({})

  const abortControllers = useRef({})
  const loadingRef = useRef(loading)
  useEffect(() => { loadingRef.current = loading }, [loading])

  // fetchLatest 等から最新の activeSession / sessions を読むための ref
  const activeSessionRef = useRef(activeSession)
  useEffect(() => { activeSessionRef.current = activeSession }, [activeSession])
  const sessionsRef = useRef(sessions)
  useEffect(() => { sessionsRef.current = sessions }, [sessions])

  // 送信世代カウンタ (session_id 単位)。 stop → 新 send の race 防止。
  const sendGenRef = useRef({})

  // 直近 POST が発行した user_request_id を保持
  const pendingRequestIdRef = useRef({})

  const buffer = useStreamBuffer({ setMessages })

  const onUserRequestId = (sid, request_id) => {
    pendingRequestIdRef.current[sid] = request_id || null
  }

  const onResultMessage = (sid, request_id) => {
    const pending = pendingRequestIdRef.current[sid]
    if (!pending || pending !== request_id) return
    pendingRequestIdRef.current[sid] = null
    buffer.cancelAndFlush(sid)
    setLoading(prev => ({ ...prev, [sid]: false }))
    setMessages(prev => {
      const cur = prev[sid] || []
      const msgs = [...cur]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'agent' && msgs[i].streaming) {
          msgs[i] = { ...msgs[i], streaming: false }
          break
        }
      }
      return { ...prev, [sid]: msgs }
    })
  }

  const reconnect = useStreamReconnect({
    setMessages,
    setLoading,
    setApiKeySource,
    buffer,
    scrollToBottom,
    isAtBottomRef,
    loadingRef,
    abortControllers,
    activeSessionRef,
    sessionsRef,
    onUserRequestId,
    onResultMessage,
  })

  const sendMessage = async () => {
    const sid = activeSession?.id
    if (!sid) return
    const text = (input[sid] || '').trim()
    const items = attachments[sid] || []
    if (!text && items.length === 0) return
    if (loading[sid]) return

    const myGen = (sendGenRef.current[sid] || 0) + 1
    sendGenRef.current[sid] = myGen
    const isCurrentGen = () => sendGenRef.current[sid] === myGen

    const imageItems = items.filter(item => item.url)
    const fileNames = items.filter(item => !item.url).map(item => item.file.name)

    const imageUrls = (await Promise.all(
      imageItems.map(item => fileToBase64(item.file).catch(() => null))
    )).filter(Boolean)
    imageItems.forEach(item => URL.revokeObjectURL(item.url))

    isAtBottomRef.current = true
    const userMsg = { id: generateId(), role: 'user', text, imageUrls, fileNames }
    const agentMsg = { id: generateId(), role: 'agent', text: '', tools: [], streaming: true }
    flushSync(() => {
      setMessages(prev => {
        const cur = prev[sid] || []
        return { ...prev, [sid]: [...cur, userMsg, agentMsg].slice(-MAX_MESSAGES) }
      })
      setInput(prev => ({ ...prev, [sid]: '' }))
      clearAttachments(sid)
      setLoading(prev => ({ ...prev, [sid]: true }))
    })
    scrollToBottom()

    const controller = new AbortController()
    abortControllers.current[sid] = controller

    buffer.resetBuf(sid)

    try {
      const formData = new FormData()
      formData.append('message', text)
      for (const item of items) {
        formData.append('files', item.file)
      }

      const res = await fetch(`${API_BASE}/chat/${sid}/stream`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

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

          try {
            processStreamEvent(reconnect.eventDeps, sid, JSON.parse(data))
          } catch { /* ignored */ }
        }
      }

      if (await reconnect.reconnectIfStreaming(sid)) return
    } catch (e) {
      if (e.name === 'AbortError') return
      if (!isCurrentGen()) return
      const errText = describeError(e)
      const recovered = await reconnect.reconnectIfStreaming(sid)
      if (!recovered) {
        if (!isCurrentGen()) return
        buffer.cancelAndFlush(sid)
        setMessages(prev => {
          const msgs = prev[sid] || []
          const last = msgs[msgs.length - 1]
          if (last?.role === 'agent' && (last.text || last.tools?.length > 0)) return prev
          return { ...prev, [sid]: [...msgs, { id: generateId(), role: 'error', text: errText }] }
        })
      }
    } finally {
      if (isCurrentGen()) {
        buffer.cancelAndFlush(sid)
        if (!reconnect.reconnectingRef.current[sid]) {
          const handledByReconnect = await reconnect.reconnectIfStreaming(sid)
          if (!handledByReconnect && isCurrentGen()) {
            setLoading(prev => ({ ...prev, [sid]: false }))
            setMessages(prev => {
              if (!isCurrentGen()) return prev
              const cur = prev[sid] || []
              const msgs = [...cur]
              if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
                msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
              }
              return { ...prev, [sid]: msgs }
            })
            if (abortControllers.current[sid] === controller) {
              abortControllers.current[sid] = null
            }
          }
        }
      }
    }
  }

  const sendAnswer = async (sid, tool_use_id, answer) => {
    setMessages(prev => {
      const cur = prev[sid] || []
      const msgs = cur.map(m => {
        if (m.askUserQuestion?.tool_use_id !== tool_use_id) return m
        return { ...m, askUserQuestion: { ...m.askUserQuestion, answered: true, selectedAnswer: answer, lastError: null } }
      })
      return { ...prev, [sid]: msgs }
    })
    try {
      const res = await fetch(`${API_BASE}/chat/${sid}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      const errText = describeError(e)
      setMessages(prev => {
        const cur = prev[sid] || []
        const msgs = cur.map(m => {
          if (m.askUserQuestion?.tool_use_id !== tool_use_id) return m
          return { ...m, askUserQuestion: { ...m.askUserQuestion, answered: false, selectedAnswer: null, lastError: errText } }
        })
        return { ...prev, [sid]: msgs }
      })
    }
  }

  const stopMessage = async () => {
    const sid = activeSession?.id
    if (!sid) return
    if (abortControllers.current[sid]) {
      abortControllers.current[sid].abort()
      abortControllers.current[sid] = null
    }
    try {
      await fetch(`${API_BASE}/chat/${sid}/stop`, { method: 'POST' })
    } catch { /* ignored */ }
    pendingRequestIdRef.current[sid] = null
    setLoading(prev => ({ ...prev, [sid]: false }))
    buffer.cancelAndFlush(sid)
    setMessages(prev => {
      const cur = prev[sid] || []
      const msgs = [...cur]
      if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
      }
      return { ...prev, [sid]: msgs }
    })
  }

  const endSession = async () => {
    const sid = activeSession?.id
    if (!sid) return
    await fetch(`${API_BASE}/sessions/${sid}/end`, { method: 'POST' })
    setMessages(prev => {
      const cur = prev[sid] || []
      // kind: 'session_end' を付けて prune ロジックの境界マーカーにする
      const ended = [
        ...cur,
        { id: generateId(), role: 'system', kind: 'session_end', text: '--- セッション終了 ---' },
      ]
      return { ...prev, [sid]: ended }
    })
  }

  return {
    loading,
    apiKeySource,
    sendMessage,
    sendAnswer,
    stopMessage,
    fetchLatest: reconnect.fetchLatest,
    endSession,
  }
}
