import { useEffect, useRef } from 'react'
import { API_BASE, MAX_MESSAGES } from '../../constants.js'
import { generateId } from '../../utils/id.js'
import { processStreamEvent } from './processStreamEvent.js'

// SSE が切れた後の復帰を担当する。
// - reconnectStream(sid)        : サーバ側 buffer を先頭から再生
// - reconnectIfStreaming(sid)   : サーバ status を見て streaming 中なら reconnect
// - checkAndReconnect(force)    : 起動時 / ネット復帰時の状態問い合わせ
// - fetchLatest()               : 「最新を取得」ボタン用
// - forceResyncAll()            : visibility/pageshow 復帰時の強制再同期
//
// セッションは動的なので、 セッションリスト (`sessionsRef.current`) から都度取り出す。
export function useStreamReconnect({
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
}) {
  const reconnectingRef = useRef({})

  const eventDeps = {
    setMessages,
    setApiKeySource,
    cancelAndFlush: buffer.cancelAndFlush,
    scheduleFlush: buffer.scheduleFlush,
    streamBufRef: buffer.streamBufRef,
    bufFor: buffer.bufFor,
    onUserRequestId,
    onResultMessage,
  }

  const allSessionIds = () => (sessionsRef.current || []).map(s => s.id)

  // reconnect: T1 移行で常に from=0 で全 buffer 再生する
  // - 204 なら false、データあり(ストリーミング完了)なら true を返す
  const reconnectStream = async (sid) => {
    const res = await fetch(`${API_BASE}/chat/${sid}/reconnect?from=0`)
    if (res.status === 204) return false
    if (!res.ok) return false

    isAtBottomRef.current = true
    setLoading(prev => ({ ...prev, [sid]: true }))
    setMessages(prev => {
      const cur = prev[sid] || []
      const last = cur[cur.length - 1]
      if (last?.role === 'agent') {
        const updated = [...cur]
        updated[updated.length - 1] = { ...last, text: '', tools: [], thinking: null, meta: undefined, streaming: true }
        return { ...prev, [sid]: updated }
      }
      return { ...prev, [sid]: [...cur, { id: generateId(), role: 'agent', text: '', tools: [], streaming: true }].slice(-MAX_MESSAGES) }
    })

    buffer.resetBuf(sid)
    // replay は通常受信と同じロジック (uuid dedup) で済ませるので、 専用のフラグは不要

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
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
          try {
            processStreamEvent(eventDeps, sid, JSON.parse(data))
          } catch { /* ignored */ }
        }
      }

      try {
        const s = await fetch(`${API_BASE}/status/${sid}`).then(r => r.json()).catch(() => null)
        if (s?.streaming) needsReconnect = true
      } catch { /* ignored */ }

      return true
    } finally {
      buffer.cancelAndFlush(sid)
      setLoading(prev => ({ ...prev, [sid]: false }))
      setMessages(prev => {
        const cur = prev[sid] || []
        const msgs = [...cur]
        if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
        }
        return { ...prev, [sid]: msgs }
      })
      requestAnimationFrame(() => { scrollToBottom() })
      if (needsReconnect) setTimeout(() => reconnectStream(sid), 1000)
    }
  }

  const reconnectIfStreaming = async (sid) => {
    try {
      const s = await fetch(`${API_BASE}/status/${sid}`).then(r => r.json()).catch(() => null)
      if (!s) return false
      if (s.streaming || s.pending_question_tool_id) {
        reconnectingRef.current[sid] = true
        reconnectStream(sid).finally(() => {
          reconnectingRef.current[sid] = false
        })
        return true
      }
    } catch { /* ignored */ }
    return false
  }

  const checkAndReconnect = async (forceReconnect = false) => {
    for (const sid of allSessionIds()) {
      if (reconnectingRef.current[sid]) continue
      if (!forceReconnect && loadingRef.current[sid]) continue
      try {
        const s = await fetch(`${API_BASE}/status/${sid}`).then(r => r.json())
        if (s.streaming) {
          setLoading(prev => ({ ...prev, [sid]: true }))
        }
        if (s.streaming || s.pending_question_tool_id) {
          if (abortControllers.current[sid]) {
            abortControllers.current[sid].abort()
            abortControllers.current[sid] = null
          }
          reconnectingRef.current[sid] = true
          reconnectStream(sid).finally(() => {
            reconnectingRef.current[sid] = false
          })
        }
      } catch { /* ignored */ }
    }
  }

  const fetchLatest = async () => {
    const active = activeSessionRef.current
    const sid = active?.id
    if (!sid || reconnectingRef.current[sid]) return

    if (abortControllers.current[sid]) {
      abortControllers.current[sid].abort()
      abortControllers.current[sid] = null
    }

    try {
      const s = await fetch(`${API_BASE}/status/${sid}`).then(r => r.json()).catch(() => null)
      if (s?.streaming) {
        setLoading(prev => ({ ...prev, [sid]: true }))
      }
    } catch { /* ignored */ }

    reconnectingRef.current[sid] = true
    try {
      const hadData = await reconnectStream(sid)
      if (!hadData) {
        const s = await fetch(`${API_BASE}/status/${sid}`).then(r => r.json()).catch(() => null)
        if (!s?.streaming) {
          setLoading(prev => ({ ...prev, [sid]: false }))
        }
      }
    } finally {
      reconnectingRef.current[sid] = false
    }
  }

  const forceResyncAll = () => {
    for (const sid of allSessionIds()) {
      if (reconnectingRef.current[sid]) continue
      if (abortControllers.current[sid]) {
        abortControllers.current[sid].abort()
        abortControllers.current[sid] = null
      }
      reconnectingRef.current[sid] = true
      reconnectStream(sid).finally(() => {
        reconnectingRef.current[sid] = false
      })
    }
  }

  // 起動時チェック
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { checkAndReconnect() }, [])

  // オフライン復帰時チェック
  useEffect(() => {
    const handle = () => checkAndReconnect(true)
    window.addEventListener('online', handle)
    return () => window.removeEventListener('online', handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // アプリ復帰時チェック
  useEffect(() => {
    let hiddenAt = null

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      const wasLong = hiddenAt != null && (Date.now() - hiddenAt) > 30_000
      hiddenAt = null

      for (const sid of allSessionIds()) buffer.cancelAndFlush(sid)
      if (wasLong) forceResyncAll()
      else checkAndReconnect(true)
      setTimeout(() => { if (!document.hidden) checkAndReconnect(true) }, 800)
      requestAnimationFrame(() => { requestAnimationFrame(() => { scrollToBottom() }) })
    }

    const onPageShow = (e) => {
      if (e.persisted) forceResyncAll()
      else checkAndReconnect(true)
    }

    const onFocus = () => {
      if (!document.hidden) checkAndReconnect(true)
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    reconnectingRef,
    reconnectStream,
    reconnectIfStreaming,
    checkAndReconnect,
    fetchLatest,
    forceResyncAll,
    eventDeps,
  }
}
