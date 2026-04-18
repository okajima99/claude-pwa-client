import { useState, useRef, useEffect } from 'react'
import LZString from 'lz-string'
import { AGENTS, MAX_MESSAGES } from '../constants.js'
import { generateId } from '../utils/id.js'

const { compressToUTF16, decompressFromUTF16 } = LZString

export function useChatStorage() {
  const [messages, setMessages] = useState(() => {
    try {
      const raw = localStorage.getItem('cpc_messages')
      if (raw) {
        const decompressed = decompressFromUTF16(raw)
        const parsed = decompressed ? JSON.parse(decompressed) : JSON.parse(raw)
        // IDがないメッセージに付与（移行対応）
        const result = {}
        for (const agent of AGENTS) {
          result[agent] = (parsed[agent] || []).map(m => m.id ? m : { ...m, id: generateId() })
        }
        return result
      }
    } catch {}
    return { agent_a: [], agent_b: [] }
  })

  const [input, setInput] = useState(() => {
    try {
      const saved = localStorage.getItem('cpc_input')
      return saved ? JSON.parse(saved) : { agent_a: '', agent_b: '' }
    } catch {
      return { agent_a: '', agent_b: '' }
    }
  })

  const msgSaveTimer = useRef(null)
  const inputSaveTimer = useRef(null)

  useEffect(() => {
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current)
    msgSaveTimer.current = setTimeout(() => {
      const toSave = {}
      for (const agent of AGENTS) {
        toSave[agent] = messages[agent].slice(-MAX_MESSAGES)
      }
      // quota 超過時は古い方から10%ずつ削って再試行（画像で膨らんだ時の救済）
      // 画面のstateは触らず、保存分だけ容量に収める
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          localStorage.setItem('cpc_messages', compressToUTF16(JSON.stringify(toSave)))
          return
        } catch {
          let reduced = false
          for (const agent of AGENTS) {
            const arr = toSave[agent]
            if (arr.length === 0) continue
            const cut = Math.max(1, Math.floor(arr.length * 0.1))
            toSave[agent] = arr.slice(cut)
            reduced = true
          }
          if (!reduced) return
        }
      }
      console.warn('[chat-storage] quota exceeded after retries')
    }, 1000)
  }, [messages])

  useEffect(() => {
    if (inputSaveTimer.current) clearTimeout(inputSaveTimer.current)
    inputSaveTimer.current = setTimeout(() => {
      localStorage.setItem('cpc_input', JSON.stringify(input))
    }, 500)
  }, [input])

  return { messages, setMessages, input, setInput }
}
