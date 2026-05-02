import { useState, useRef, useEffect } from 'react'
import LZString from 'lz-string'
import { LEGACY_AGENT_TO_SESSION, LS_MESSAGES, LS_INPUT, MAX_MESSAGES } from '../constants.js'
import { generateId } from '../utils/id.js'

const { compressToUTF16, decompressFromUTF16 } = LZString

// 旧 agent_a / agent_b キーは「履歴を引き継がない方針」 になったので、 検出したら
// そのまま削除する (引き継ぎはしない)。
function dropLegacyKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = { ...obj }
  for (const legacyKey of Object.keys(LEGACY_AGENT_TO_SESSION)) {
    if (legacyKey in out) delete out[legacyKey]
  }
  return out
}

// 「セッション終了」 マーカー (= kind: 'session_end' の system メッセージ) を境界にして、
// 「現在進行中の会話 + 直前に終了した 1 セッションぶん」 だけ残す。
// マーカーが N 個以上あれば、 末尾から (KEEP_PREV_SESSIONS) 個目のマーカーより前を全部捨てる。
const KEEP_PREV_SESSIONS = 1 // 「1 個前の終了済みセッション」 まで保持

function pruneOldSessions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return arr
  // 末尾から走査して N+1 個目のマーカーの位置を探す (= そこ以前を捨てる)
  // 例: KEEP_PREV_SESSIONS=1 なら、 末尾から 2 個目の session_end マーカーより前を捨てる
  const targetMarkerIndex = KEEP_PREV_SESSIONS + 1
  let found = 0
  let cutAt = -1
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.role === 'system' && arr[i]?.kind === 'session_end') {
      found += 1
      if (found === targetMarkerIndex) {
        cutAt = i
        break
      }
    }
  }
  if (cutAt < 0) return arr // マーカーがそこまで無い = まだ削るほど履歴が無い
  return arr.slice(cutAt + 1)
}

// session_id をキーとして messages / input を localStorage と同期する。
// セッションが動的に増減するため、 dict は lazy init: 知らない session_id にアクセス
// した側 (useChatStream など) は空配列 / 空文字列を期待してよい。
export function useChatStorage(sessions) {
  const [messages, setMessages] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_MESSAGES)
      if (raw) {
        const decompressed = decompressFromUTF16(raw)
        let parsed = decompressed ? JSON.parse(decompressed) : JSON.parse(raw)
        parsed = dropLegacyKeys(parsed)
        // ID なしメッセージへの ID 付与 (移行対応) + ロード時にも prune を適用
        const result = {}
        if (parsed && typeof parsed === 'object') {
          for (const [sid, arr] of Object.entries(parsed)) {
            if (!Array.isArray(arr)) continue
            const withIds = arr.map(m => m.id ? m : { ...m, id: generateId() })
            result[sid] = pruneOldSessions(withIds)
          }
        }
        return result
      }
    } catch { /* ignored */ }
    return {}
  })

  const [input, setInput] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_INPUT)
      if (saved) {
        const parsed = dropLegacyKeys(JSON.parse(saved))
        if (parsed && typeof parsed === 'object') return parsed
      }
    } catch { /* ignore */ }
    return {}
  })

  // sessions が変わったタイミングで、 知らない session_id 用の空エントリを補う
  // (ない場合の `messages[sid]` アクセスを `[]` で安全に受けるため)
  useEffect(() => {
    setMessages(prev => {
      let changed = false
      const next = { ...prev }
      for (const s of sessions) {
        if (!(s.id in next)) { next[s.id] = []; changed = true }
      }
      // 削除されたセッションのキーは保持してもメモリ的に問題ない (永続化時に絞る)
      return changed ? next : prev
    })
    setInput(prev => {
      let changed = false
      const next = { ...prev }
      for (const s of sessions) {
        if (!(s.id in next)) { next[s.id] = ''; changed = true }
      }
      return changed ? next : prev
    })
  }, [sessions])

  const msgSaveTimer = useRef(null)
  const inputSaveTimer = useRef(null)

  // messages を localStorage に書く時は、 現存セッションぶんだけに絞り、
  // セッション終了マーカーを境界にして「現在 + 1 個前」 までに prune する。
  useEffect(() => {
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current)
    msgSaveTimer.current = setTimeout(() => {
      const toSave = {}
      const sids = sessions.map(s => s.id)
      for (const sid of sids) {
        const arr = pruneOldSessions(messages[sid] || [])
        toSave[sid] = arr.slice(-MAX_MESSAGES)
      }
      // quota 超過時は古い方から 10% ずつ削って再試行 (画像で膨らんだ時の救済)
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          localStorage.setItem(LS_MESSAGES, compressToUTF16(JSON.stringify(toSave)))
          return
        } catch {
          let reduced = false
          for (const sid of sids) {
            const arr = toSave[sid]
            if (!arr || arr.length === 0) continue
            const cut = Math.max(1, Math.floor(arr.length * 0.1))
            toSave[sid] = arr.slice(cut)
            reduced = true
          }
          if (!reduced) return
        }
      }
      console.warn('[chat-storage] quota exceeded after retries')
    }, 1000)
  }, [messages, sessions])

  useEffect(() => {
    if (inputSaveTimer.current) clearTimeout(inputSaveTimer.current)
    inputSaveTimer.current = setTimeout(() => {
      const toSave = {}
      for (const s of sessions) {
        toSave[s.id] = input[s.id] || ''
      }
      try { localStorage.setItem(LS_INPUT, JSON.stringify(toSave)) } catch { /* ignore */ }
    }, 500)
  }, [input, sessions])

  return { messages, setMessages, input, setInput }
}
