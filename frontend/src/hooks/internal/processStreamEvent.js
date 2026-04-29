import { generateId } from '../../utils/id.js'
import { formatTool } from '../../utils/format.js'
import { MAX_MESSAGES } from '../../constants.js'

// SSE イベント (1 行 JSON) を受け取って、buffer / messages state に反映する純粋関数。
// 副作用は deps 経由で渡された setter / ref で行う (テスト時に差し替え可能)。
//
// 扱うイベント種別:
//   system / init       — apiKeySource 取得
//   system / compact_boundary — 会話圧縮の系統バナー
//   result              — ターン完了 meta 埋め込み
//   ask_user_question   — AskUserQuestion バブル
//   user (tool_result)  — 既存 tool_use に結果を紐付ける
//   assistant           — text / thinking / tool_use → buffer に積む
export function processStreamEvent(deps, agent, event) {
  const {
    setMessages,
    setApiKeySource,
    cancelAndFlush,
    scheduleFlush,
    streamBufRef,
    currentBubbleHasToolsRef,
    replayModeRef,
  } = deps

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
