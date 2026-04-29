import { useEffect, useRef } from 'react'
import { API_BASE, AGENTS, MAX_MESSAGES } from '../../constants.js'
import { generateId } from '../../utils/id.js'
import { processStreamEvent } from './processStreamEvent.js'

// SSE が切れた後の復帰を担当する。
// - reconnectStream(agent)        : サーバ側 buffer を先頭から再生
// - _reconnectIfStreaming(agent)  : サーバ status を見て streaming 中なら reconnect
// - checkAndReconnect(force)      : 起動時 / ネット復帰時の状態問い合わせ
// - fetchLatest()                 : 「最新を取得」ボタン用
// - forceResyncAll()              : visibility/pageshow 復帰時の強制再同期
//
// visibilitychange / pageshow / focus / online のリスナを 1 ヶ所に集約する。
export function useStreamReconnect({
  setMessages,
  setLoading,
  setApiKeySource,
  buffer,
  scrollToBottom,
  isAtBottomRef,
  loadingRef,
  abortControllers,
  activeAgentRef,
}) {
  const reconnectingRef = useRef({ agent_a: false, agent_b: false })

  const eventDeps = {
    setMessages,
    setApiKeySource,
    cancelAndFlush: buffer.cancelAndFlush,
    scheduleFlush: buffer.scheduleFlush,
    streamBufRef: buffer.streamBufRef,
    currentBubbleHasToolsRef: buffer.currentBubbleHasToolsRef,
    replayModeRef: buffer.replayModeRef,
  }

  // reconnect: T1 移行で常に from=0 で全 buffer 再生する
  // - 204 なら false、データあり(ストリーミング完了)なら true を返す
  // - 既存の最後の agent バブルは中身をリセット → 受信イベントで再構築（重複防止）
  const reconnectStream = async (agent) => {
    const res = await fetch(`${API_BASE}/chat/${agent}/reconnect?from=0`)
    if (res.status === 204) return false
    if (!res.ok) return false

    isAtBottomRef.current = true
    setLoading(prev => ({ ...prev, [agent]: true }))
    setMessages(prev => {
      const msgs = prev[agent]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'agent') {
        // 既存の最後 agent バブルを空にして再構築（from=0 全 replay と整合させる）
        const updated = [...msgs]
        updated[updated.length - 1] = { ...last, text: '', tools: [], thinking: null, meta: undefined, streaming: true }
        return { ...prev, [agent]: updated }
      }
      return { ...prev, [agent]: [...msgs, { id: generateId(), role: 'agent', text: '', tools: [], streaming: true }].slice(-MAX_MESSAGES) }
    })

    // バッファ初期化（reconnect中はバブル分割を抑制）
    buffer.resetBuf(agent)
    buffer.replayModeRef.current[agent] = true

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
            processStreamEvent(eventDeps, agent, JSON.parse(data))
          } catch { /* ignored */ }
        }
      }

      // ストリームが静かに切れた場合の再接続チェック
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
        if (s?.streaming) needsReconnect = true
      } catch { /* ignored */ }

      return true
    } finally {
      buffer.replayModeRef.current[agent] = false
      buffer.cancelAndFlush(agent)
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

  // サーバーがまだ streaming 中なら reconnect を起動（fire-and-forget）
  // reconnectingRef は即時セットされるので呼び出し側 finally の二重起動防止も効く
  const reconnectIfStreaming = async (agent) => {
    try {
      const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
      if (!s) return false
      if (s.streaming || s.pending_question_tool_id) {
        reconnectingRef.current[agent] = true
        reconnectStream(agent).finally(() => {
          reconnectingRef.current[agent] = false
        })
        return true
      }
    } catch { /* ignored */ }
    return false
  }

  // 処理中ストリームへの再接続チェック（重複防止つき）
  // T1: バッファ位置を持たないので「streaming中 or 質問待ち」だけで判定する
  const checkAndReconnect = async (forceReconnect = false) => {
    for (const agent of AGENTS) {
      if (reconnectingRef.current[agent]) continue
      if (!forceReconnect && loadingRef.current[agent]) continue
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json())
        if (s.streaming) {
          setLoading(prev => ({ ...prev, [agent]: true }))
        }
        if (s.streaming || s.pending_question_tool_id) {
          if (abortControllers.current[agent]) {
            abortControllers.current[agent].abort()
            abortControllers.current[agent] = null
          }
          reconnectingRef.current[agent] = true
          reconnectStream(agent).finally(() => {
            reconnectingRef.current[agent] = false
          })
        }
      } catch { /* ignored */ }
    }
  }

  // 「最新を取得」ボタン専用: サーバーバッファを先頭から再構築する
  const fetchLatest = async () => {
    const agent = activeAgentRef.current
    if (reconnectingRef.current[agent]) return

    if (abortControllers.current[agent]) {
      abortControllers.current[agent].abort()
      abortControllers.current[agent] = null
    }

    try {
      const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
      if (s?.streaming) {
        setLoading(prev => ({ ...prev, [agent]: true }))
      }
    } catch { /* ignored */ }

    reconnectingRef.current[agent] = true
    try {
      const hadData = await reconnectStream(agent)
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

  // 全 agent に対して reconnectStream を強制発火する（バッファ先頭から再生）。
  // iOS swipe-up や bfcache 復帰時など、SSE が切れている可能性が高い場面で使う。
  const forceResyncAll = () => {
    for (const agent of AGENTS) {
      if (reconnectingRef.current[agent]) continue
      if (abortControllers.current[agent]) {
        abortControllers.current[agent].abort()
        abortControllers.current[agent] = null
      }
      reconnectingRef.current[agent] = true
      reconnectStream(agent).finally(() => {
        reconnectingRef.current[agent] = false
      })
    }
  }

  // アプリ起動時チェック（マウント時に1回だけ）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { checkAndReconnect() }, [])

  // オフライン復帰時チェック（リスナー登録は1回だけ。checkAndReconnect は最新参照を使う）
  useEffect(() => {
    const handle = () => checkAndReconnect(true)
    window.addEventListener('online', handle)
    return () => window.removeEventListener('online', handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // アプリ復帰時チェック（visibilitychange / pageshow / focus / 遅延再チェックを併設）
  // - visibilitychange: タブ切替・短時間バックグラウンド復帰
  // - pageshow + persisted: bfcache 復帰
  // - focus: iOS で visibilitychange が発火しない経路の保険（swipe-up からの復帰等）
  // - 30 秒以上のバックグラウンド: SSE が iOS により切断されている可能性が高いので強制再同期
  useEffect(() => {
    let hiddenAt = null

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      const wasLong = hiddenAt != null && (Date.now() - hiddenAt) > 30_000
      hiddenAt = null

      for (const agent of AGENTS) buffer.cancelAndFlush(agent)
      if (wasLong) forceResyncAll()
      else checkAndReconnect(true)
      // 復帰直後に古い fetch がまだ握っているケースのカバー
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
