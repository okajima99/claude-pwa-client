import { useState, useRef, useEffect } from 'react'
import LZString from 'lz-string'
import { LEGACY_AGENT_TO_SESSION, LS_MESSAGES, LS_INPUT, MAX_MESSAGES } from '../constants.js'
import { generateId } from '../utils/id.js'

const { compressToUTF16, decompressFromUTF16 } = LZString

function migrateLegacyKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = { ...obj }
  for (const [legacyKey, newKey] of Object.entries(LEGACY_AGENT_TO_SESSION)) {
    if (legacyKey in out) {
      // 既に new key 側にもデータがある場合は new key を優先 (新 backend 由来)
      if (!(newKey in out)) {
        out[newKey] = out[legacyKey]
      }
      delete out[legacyKey]
    }
  }
  return out
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
        // 旧 agent_a / agent_b キーがあれば ses_legacy_a / ses_legacy_b にリネーム
        parsed = migrateLegacyKeys(parsed)
        // ID なしメッセージへの ID 付与 (移行対応)
        const result = {}
        if (parsed && typeof parsed === 'object') {
          for (const [sid, arr] of Object.entries(parsed)) {
            if (!Array.isArray(arr)) continue
            result[sid] = arr.map(m => m.id ? m : { ...m, id: generateId() })
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
        const parsed = migrateLegacyKeys(JSON.parse(saved))
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

  // messages を localStorage に書く時は、 現存セッションぶんだけに絞る
  useEffect(() => {
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current)
    msgSaveTimer.current = setTimeout(() => {
      const toSave = {}
      const sids = sessions.map(s => s.id)
      for (const sid of sids) {
        const arr = messages[sid] || []
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
