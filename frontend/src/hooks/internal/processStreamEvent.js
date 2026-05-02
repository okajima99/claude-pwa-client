import { generateId } from '../../utils/id.js'
import { formatTool } from '../../utils/format.js'
import { MAX_MESSAGES } from '../../constants.js'

// SSE イベント (1 行 JSON) を受け取って、buffer / messages state に反映する純粋関数。
// 副作用は deps 経由で渡された setter / ref で行う (テスト時に差し替え可能)。
//
// 第 2 引数 `sid` = session_id (UI 上のタブ ID)。
//
// 扱うイベント種別:
//   request_id          — backend が発行した user 起点 ID をフロントが保持
//   system / init       — apiKeySource 取得
//   system / compact_boundary — 会話圧縮の系統バナー
//   result              — ターン完了 meta 埋め込み
//   ask_user_question   — AskUserQuestion バブル
//   user (tool_result)  — 既存 tool_use に結果を紐付ける
//   assistant           — text / thinking / tool_use → buffer に積む
export function processStreamEvent(deps, sid, event) {
  const {
    setMessages,
    setApiKeySource,
    cancelAndFlush,
    scheduleFlush,
    streamBufRef,
    bufFor,
    onUserRequestId,
    onResultMessage,
  } = deps

  if (event.type === 'request_id') {
    if (typeof onUserRequestId === 'function') onUserRequestId(sid, event.request_id)
    return
  }

  if (event.type === 'system' && event.subtype === 'init') {
    if (event.apiKeySource) {
      setApiKeySource(prev => ({ ...prev, [sid]: event.apiKeySource }))
    }
    return
  }

  // compact_boundary: 会話圧縮タイミング。 メタを system バブルとして差し込む。
  if (event.type === 'system' && event.subtype === 'compact_boundary') {
    cancelAndFlush(sid)
    const meta = event.compactMetadata || {}
    const uuid = event.uuid || null
    setMessages(prev => {
      const msgs = prev[sid] || []
      if (uuid && msgs.some(m => m.role === 'system' && m.kind === 'compact' && m.uuid === uuid)) {
        return prev
      }
      return {
        ...prev,
        [sid]: [...msgs, {
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

  // result: 直近 agent バブルに meta 埋め込み + 送信ボタン解放
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
    cancelAndFlush(sid)
    setMessages(prev => {
      const cur = prev[sid] || []
      const msgs = [...cur]
      const last = msgs[msgs.length - 1]
      if (last?.role !== 'agent') return prev
      msgs[msgs.length - 1] = { ...last, meta }
      return { ...prev, [sid]: msgs }
    })
    if (typeof onResultMessage === 'function') onResultMessage(sid, event.request_id)
    return
  }

  // AskUserQuestion バブル
  if (event.type === 'ask_user_question') {
    const tool_use_id = event.tool_use_id
    const questions = event.input?.questions || []
    cancelAndFlush(sid)
    setMessages(prev => {
      const cur = prev[sid] || []
      const msgs = [...cur]
      const last = msgs[msgs.length - 1]
      const aq = { tool_use_id, questions, answered: false, selectedAnswer: null }
      if (last?.role === 'agent') {
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
      return { ...prev, [sid]: msgs }
    })
    return
  }

  // user の tool_result を既存 tool_use に紐付ける
  if (event.type === 'user' && event.message?.content && !event.parent_tool_use_id) {
    const results = Array.isArray(event.message.content)
      ? event.message.content.filter(b => b?.type === 'tool_result')
      : []
    if (results.length === 0) return
    cancelAndFlush(sid)
    setMessages(prev => {
      const msgs = prev[sid] || []
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
      return mutated ? { ...prev, [sid]: updated } : prev
    })
    return
  }

  if (event.type !== 'assistant' || !event.message?.content) return
  if (event.parent_tool_use_id) return

  const textContent = event.message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
  const thinkingContent = event.message.content
    .filter(b => b.type === 'thinking')
    .map(b => b.thinking)
    .join('\n')
  const newTools = event.message.content
    .filter(b => b.type === 'tool_use' && b.name !== 'Agent' && b.name !== 'AskUserQuestion' && b.name !== 'TodoWrite')
    .map(b => formatTool(b))

  // 通常受信も replay も同じロジックで処理し、 バブル単位の重複は uuid で flush 時に dedup する。
  // (event.uuid = AssistantMessage の uuid。 同じものを 2 回 replay しても 1 つの bubble に収束)
  const buf = bufFor ? bufFor(sid) : streamBufRef.current[sid]
  buf.needsNewBubble = true
  buf.text = textContent
  buf.thinking = thinkingContent || null
  buf.newTools = newTools
  buf.uuid = event.uuid || null
  buf.dirty = true
  scheduleFlush(sid)
}
