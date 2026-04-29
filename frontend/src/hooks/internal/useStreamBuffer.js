import { useRef } from 'react'
import { AGENTS } from '../../constants.js'
import { generateId } from '../../utils/id.js'

// SSE で飛んでくる細切れの assistant 更新 (text / thinking / tool_use) を、
// rAF で 1 フレームに 1 回だけ React state にコミットするためのバッファ。
// SDK は数十 ms 周期で更新を投げるので、setState を毎回呼ぶと再描画が詰まる。
//
// 公開する ref:
// - streamBufRef                 : 受信中の最新スナップショット
// - currentBubbleHasToolsRef     : 直近バブルに tool_use を含めたか (バブル分割境界判定用)
// - replayModeRef                : reconnect 中フラグ (バブル分割を抑止する)
//
// 公開関数:
// - flushStreamBuf(agent)        : バッファを setState に反映
// - scheduleFlush(agent)         : rAF で 1 回だけ flush を予約
// - cancelAndFlush(agent)        : 予約をキャンセルして即 flush
// - resetBuf(agent)              : 新規ターン / reconnect 開始時の初期化
function makeEmptyBufs() {
  return Object.fromEntries(
    AGENTS.map(a => [a, { text: null, thinking: null, newTools: [], needsNewBubble: false, dirty: false }])
  )
}
function makePerAgent(value) {
  return Object.fromEntries(AGENTS.map(a => [a, value]))
}

export function useStreamBuffer({ setMessages }) {
  // useRef の引数は初回のみ使われる。毎レンダーで初期化関数が呼ばれるが
  // AGENTS は 2 件なのでオーバーヘッドは無視できる。
  const streamBufRef = useRef(makeEmptyBufs())
  const rafIdRef = useRef(makePerAgent(null))
  const currentBubbleHasToolsRef = useRef(makePerAgent(false))
  const replayModeRef = useRef(makePerAgent(false))

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

  const resetBuf = (agent) => {
    streamBufRef.current[agent] = { text: null, thinking: null, newTools: [], needsNewBubble: false, dirty: false }
    currentBubbleHasToolsRef.current[agent] = false
  }

  return {
    streamBufRef,
    currentBubbleHasToolsRef,
    replayModeRef,
    flushStreamBuf,
    scheduleFlush,
    cancelAndFlush,
    resetBuf,
  }
}
