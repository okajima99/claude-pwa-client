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
  // SDK init イベントから取得する API キー由来。"none" なら OAuth/サブスクリプション経路（実課金ゼロ）
  const [apiKeySource, setApiKeySource] = useState({ agent_a: null, agent_b: null })

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

  // reconnect中はバブル分割を抑制するフラグ
  const replayModeRef = useRef({ agent_a: false, agent_b: false })

  // 旧バッファ位置追跡キーの掃除（T1: from=0 固定移行で不要になった）
  useEffect(() => {
    try {
      localStorage.removeItem('cpc_bufpos')
      localStorage.removeItem('cpc_bufid')
    } catch {}
  }, [])

  // サーバーがまだ streaming 中なら reconnect を起動（fire-and-forget）
  // reconnectingRef は即時セットされるので呼び出し側 finally の二重起動防止も効く
  const _reconnectIfStreaming = async (agent) => {
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
    // system init: apiKeySource を取得（"none" なら subscription/OAuth 経路で課金ゼロ）
    if (event.type === 'system' && event.subtype === 'init') {
      if (event.apiKeySource) {
        setApiKeySource(prev => ({ ...prev, [agent]: event.apiKeySource }))
      }
      return
    }

    // result: 直近の agent バブルに meta（コスト・所要時間・ターン数・モデル・トークン・stop_reason）を埋め込む
    if (event.type === 'result') {
      const meta = {
        cost_usd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        num_turns: typeof event.num_turns === 'number' ? event.num_turns : null,
        duration_ms: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        modelUsage: event.modelUsage || null,
        usage: event.usage || null,
        stop_reason: typeof event.stop_reason === 'string' ? event.stop_reason : null,
        is_error: !!event.is_error,
      }
      setMessages(prev => {
        const msgs = [...prev[agent]]
        const last = msgs[msgs.length - 1]
        if (last?.role !== 'agent') return prev
        msgs[msgs.length - 1] = { ...last, meta }
        return { ...prev, [agent]: msgs }
      })
      return
    }

    // AskUserQuestion: 直近の agent バブルに askUserQuestion を埋め込む（既存バブルがなければ新規）
    if (event.type === 'ask_user_question') {
      const tool_use_id = event.tool_use_id
      const questions = event.input?.questions || []
      setMessages(prev => {
        const msgs = [...prev[agent]]
        const last = msgs[msgs.length - 1]
        const aq = { tool_use_id, questions, answered: false, selectedAnswer: null }
        if (last?.role === 'agent') {
          // 同じ tool_use_id が既に埋まっていたらスキップ（再 replay 時の冪等性）
          if (last.askUserQuestion?.tool_use_id === tool_use_id) return prev
          msgs[msgs.length - 1] = { ...last, askUserQuestion: aq }
        } else {
          msgs.push({
            id: generateId(),
            role: 'agent',
            text: '',
            tools: [],
            askUserQuestion: aq,
            streaming: true,
          })
        }
        return { ...prev, [agent]: msgs }
      })
      return
    }

    // user イベントの tool_result を既存 tool に紐付ける
    // サブエージェント内部の tool_result は表示しない
    if (event.type === 'user' && event.message?.content && !event.parent_tool_use_id) {
      const results = Array.isArray(event.message.content)
        ? event.message.content.filter(b => b?.type === 'tool_result')
        : []
      if (results.length === 0) return
      // 直近のバブルに含まれる tool に result を埋め込む（過去 walk）
      setMessages(prev => {
        const msgs = prev[agent]
        let mutated = false
        const updated = msgs.map(m => {
          if (m.role !== 'agent' || !m.tools?.length) return m
          let toolMutated = false
          const newTools = m.tools.map(t => {
            const r = results.find(x => x.tool_use_id === t.id)
            if (!r) return t
            toolMutated = true
            return { ...t, result: { content: r.content, is_error: !!r.is_error } }
          })
          if (!toolMutated) return m
          mutated = true
          return { ...m, tools: newTools }
        })
        return mutated ? { ...prev, [agent]: updated } : prev
      })
      return
    }

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
    // Agent（サブエージェント）/AskUserQuestion/TodoWrite は ActivityBar or 専用UIで描画するため tool-log から除外
    const newTools = event.message.content
      .filter(b => b.type === 'tool_use' && b.name !== 'Agent' && b.name !== 'AskUserQuestion' && b.name !== 'TodoWrite')
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
      } catch {}
    }
  }

  // 「最新を取得」ボタン専用: サーバーバッファを先頭から再構築する
  // T1 移行後は reconnectStream 自身がバブルリセット＋from=0 取得をやるので薄いラッパーになった
  const fetchLatest = async () => {
    const agent = activeAgent
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
    } catch {}

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

          try {
            processStreamEvent(agent, JSON.parse(data))
          } catch {}
        }
      }

      // SSEが静かに切れた場合の復旧: サーバーがまだ streaming 中なら追いかける
      if (await _reconnectIfStreaming(agent)) return
    } catch (e) {
      if (e.name === 'AbortError') return
      const errText = describeError(e)
      // 通信失敗時: reconnectで取り戻せれば続行、ダメならエラー表示
      const recovered = await _reconnectIfStreaming(agent)
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
      if (await _reconnectIfStreaming(agent)) return

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
    streamBufRef.current[agent] = { text: null, thinking: null, newTools: [], needsNewBubble: false, dirty: false }
    currentBubbleHasToolsRef.current[agent] = false
    replayModeRef.current[agent] = true

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
            processStreamEvent(agent, JSON.parse(data))
          } catch {}
        }
      }

      // ストリームが静かに切れた場合の再接続チェック
      try {
        const s = await fetch(`${API_BASE}/status/${agent}`).then(r => r.json()).catch(() => null)
        if (s?.streaming) needsReconnect = true
      } catch {}

      return true
    } finally {
      replayModeRef.current[agent] = false
      cancelAndFlush(agent)
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

  const sendAnswer = async (agent, tool_use_id, answer) => {
    // UI 側を先にロック（楽観更新）。前回失敗のエラー表示があればクリア
    setMessages(prev => {
      const msgs = prev[agent].map(m => {
        if (m.askUserQuestion?.tool_use_id !== tool_use_id) return m
        return { ...m, askUserQuestion: { ...m.askUserQuestion, answered: true, selectedAnswer: answer, lastError: null } }
      })
      return { ...prev, [agent]: msgs }
    })
    try {
      const res = await fetch(`${API_BASE}/chat/${agent}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      // 失敗したらロックを解除し、エラー文言を埋めて再試行可能にする
      const errText = describeError(e)
      setMessages(prev => {
        const msgs = prev[agent].map(m => {
          if (m.askUserQuestion?.tool_use_id !== tool_use_id) return m
          return { ...m, askUserQuestion: { ...m.askUserQuestion, answered: false, selectedAnswer: null, lastError: errText } }
        })
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
    await fetch(`${API_BASE}/session/${activeAgent}/end`, { method: 'POST' })
    setMessages(prev => ({
      ...prev,
      [activeAgent]: [...prev[activeAgent], { id: generateId(), role: 'system', text: '--- セッション終了 ---' }],
    }))
  }

  return {
    loading,
    apiKeySource,
    sendMessage,
    sendAnswer,
    stopMessage,
    fetchLatest,
    endSession,
  }
}
