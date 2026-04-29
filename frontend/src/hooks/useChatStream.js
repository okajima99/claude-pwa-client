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
  // 送信世代カウンタ。stop → 新 send の race で「古い send の finally が新 send の状態
  // (loading / streaming flag / 最後のバブル / streamBuf) を巻き込んで壊す」のを防ぐ。
  // 新 send は myGen++ で世代を進める。古い finally は myGen が最新かを await の前後で
  // 確認し、世代が古ければ何もせず抜ける。
  const sendGenRef = useRef({ agent_a: 0, agent_b: 0 })

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
    } catch { /* ignored */ }
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

    // compact_boundary: 会話圧縮が走ったタイミング。メタ(trigger / pre/post tokens / 所要時間)を
    // 独立した system バブルとして差し込む。事前イベントは SDK に無いため事後通知のみ。
    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      // 直近バブルを確定してから system 行を差し込む（RAF 待ちの tool_use が後から挿入されて
      // 位置が逆転するのを防ぐ）
      cancelAndFlush(agent)
      const meta = event.compactMetadata || {}
      const uuid = event.uuid || null
      setMessages(prev => {
        const msgs = prev[agent]
        // reconnect 再生時の重複挿入を防ぐ
        if (uuid && msgs.some(m => m.role === 'system' && m.kind === 'compact' && m.uuid === uuid)) {
          return prev
        }
        return {
          ...prev,
          [agent]: [...msgs, {
            id: generateId(),
            role: 'system',
            kind: 'compact',
            uuid,
            trigger: meta.trigger || null,
            preTokens: typeof meta.preTokens === 'number' ? meta.preTokens : null,
            postTokens: typeof meta.postTokens === 'number' ? meta.postTokens : null,
            durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
          }].slice(-MAX_MESSAGES),
        }
      })
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
      // バブルがまだバッファ内 (RAF 待ち) だと last?.role !== 'agent' で弾かれ meta が消える。
      // 先にバッファを強制フラッシュしてから meta を attach する。
      cancelAndFlush(agent)
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
      // バブルがバッファ内だと既存判定に失敗し余計な空バブルが作られうる
      cancelAndFlush(agent)
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
      // 直近の tool_use がまだバッファ内 (RAF 待ち) だと setMessages 側の tools に
      // 存在せず id マッチに失敗して result が消える。先にバッファを強制フラッシュする。
      cancelAndFlush(agent)
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
    // バブル分割判定はフィルタ前の全 tool_use 数を使う。
    // フィルタで除外された tool (TodoWrite 等) を挟んだ後の text が前のテキストを上書きしてしまうバグの対策。
    const hasAnyToolUse = event.message.content.some(b => b.type === 'tool_use')

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
      }
      // 表示しない tool でもバブル分割の境界として扱う
      if (hasAnyToolUse) {
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
      } catch { /* ignored */ }
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

      for (const agent of AGENTS) cancelAndFlush(agent)
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

  const sendMessage = async () => {
    const agent = activeAgent
    const text = input[agent].trim()
    const items = attachments[agent]
    if (!text && items.length === 0) return
    if (loading[agent]) return

    // 世代を進めて自分専用の myGen を確保。古い send の finally は myGen の鮮度で
    // 「自分はもう過去の send」と判定して撤退する。
    const myGen = ++sendGenRef.current[agent]
    const isCurrentGen = () => sendGenRef.current[agent] === myGen

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
          } catch { /* ignored */ }
        }
      }

      // SSEが静かに切れた場合の復旧: サーバーがまだ streaming 中なら追いかける
      if (await _reconnectIfStreaming(agent)) return
    } catch (e) {
      if (e.name === 'AbortError') return
      // 自分が「過去の send」になっていたらエラー表示も新 send の世界を汚すので何もしない
      if (!isCurrentGen()) return
      const errText = describeError(e)
      // 通信失敗時: reconnectで取り戻せれば続行、ダメならエラー表示
      const recovered = await _reconnectIfStreaming(agent)
      if (!recovered) {
        if (!isCurrentGen()) return
        // バッファ未反映の text/tools があると last の判定をすり抜け、余計なエラーバブルが
        // 追加されたあと後段の flush で内容が復活して二重表示になる。先に確定させる。
        cancelAndFlush(agent)
        setMessages(prev => {
          const msgs = prev[agent]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'agent' && (last.text || last.tools?.length > 0)) return prev
          return { ...prev, [agent]: [...msgs, { id: generateId(), role: 'error', text: errText }] }
        })
      }
    } finally {
      // finally 内の早期 return は no-unsafe-finally 違反になるため、
      // 条件をネストして同等の挙動を保つ:
      // - 古い send (stop で中断され新 send が走り始めているケース): 状態を触らずに撤退
      // - reconnectStream が走っている間: そちらが最終化するので触らない
      // - post-stream check (再接続) が走った場合: そちらが最終化
      if (isCurrentGen()) {
        cancelAndFlush(agent)
        if (!reconnectingRef.current[agent]) {
          const handledByReconnect = await _reconnectIfStreaming(agent)
          // await のあとに新 send が割り込んでいる可能性があるため再チェック
          if (!handledByReconnect && isCurrentGen()) {
            setLoading(prev => ({ ...prev, [agent]: false }))
            setMessages(prev => {
              if (!isCurrentGen()) return prev
              const msgs = [...prev[agent]]
              if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
                msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
              }
              return { ...prev, [agent]: msgs }
            })
            // compare-and-swap: 自分の controller がまだ載っているときだけ null に戻す
            if (abortControllers.current[agent] === controller) {
              abortControllers.current[agent] = null
            }
          }
        }
      }
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
    } catch { /* ignored */ }
    setLoading(prev => ({ ...prev, [agent]: false }))
    // バッファ残りを今のバブルに反映してから streaming フラグを下ろす。
    // (このあと新 send が走った場合、古い send の finally は世代チェックで撤退するので、
    //  ここで確定させておかないと中断バブルが「ぐるぐる」のまま残る)
    cancelAndFlush(agent)
    setMessages(prev => {
      const msgs = [...prev[agent]]
      if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
      }
      return { ...prev, [agent]: msgs }
    })
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
