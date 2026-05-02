import { useCallback, useEffect, useRef, useState } from 'react'
import {
  API_BASE,
  LEGACY_AGENT_TO_SESSION,
  LS_ACTIVE_SESSION,
  LS_LEGACY_ACTIVE_AGENT,
  LS_SESSIONS_META,
} from '../constants.js'

// セッション (= UI 上の 1 タブ = 1 議題) のリストと、 現在 active な session_id を管理する。
// backend `/sessions` を真値とし、 起動時に GET でローカルの localStorage と同期する。
// ローカル先読みでオフライン時の表示を維持しつつ、 ネットワーク復帰時に backend を信頼する。
export function useSessions() {
  // 起動時は localStorage から先読み (オフラインでもとりあえず描画する)
  const [sessions, setSessions] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_SESSIONS_META)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed
      }
    } catch { /* ignore */ }
    return []
  })

  const [activeId, setActiveId] = useState(() => {
    try {
      const id = localStorage.getItem(LS_ACTIVE_SESSION)
      if (id) return id
      // 旧 cpc_active_agent からマイグレーション
      const legacy = localStorage.getItem(LS_LEGACY_ACTIVE_AGENT)
      if (legacy && legacy in LEGACY_AGENT_TO_SESSION) {
        const migrated = LEGACY_AGENT_TO_SESSION[legacy]
        try {
          localStorage.setItem(LS_ACTIVE_SESSION, migrated)
          localStorage.removeItem(LS_LEGACY_ACTIVE_AGENT)
        } catch { /* ignore */ }
        return migrated
      }
    } catch { /* ignore */ }
    return null
  })

  const [agents, setAgents] = useState([]) // 作成時の選択肢 (backend 設定済 agent 一覧)
  const initRef = useRef(false)

  // localStorage 同期 (sessions / activeId が変わるたび)
  useEffect(() => {
    try { localStorage.setItem(LS_SESSIONS_META, JSON.stringify(sessions)) } catch { /* ignore */ }
  }, [sessions])
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(LS_ACTIVE_SESSION, activeId)
      else localStorage.removeItem(LS_ACTIVE_SESSION)
    } catch { /* ignore */ }
  }, [activeId])

  // 起動時に backend の真値を取得して同期
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    Promise.all([
      fetch(`${API_BASE}/sessions`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/agents`).then(r => r.json()).catch(() => null),
    ]).then(([serverSessions, serverAgents]) => {
      if (Array.isArray(serverAgents)) setAgents(serverAgents)
      if (Array.isArray(serverSessions)) {
        // 並び順: created_at 降順 (新しい順) で固定。 ChatGPT と同じく新規作成が一番上
        const sorted = [...serverSessions].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        setSessions(sorted)
        // active が backend に居ない or 未設定なら先頭 (= 一番新しい) に寄せる
        setActiveId(prev => {
          if (prev && sorted.some(s => s.id === prev)) return prev
          return sorted.length > 0 ? sorted[0].id : null
        })
      }
    })
  }, [])

  const createSession = useCallback(async (agentId, title) => {
    const body = { agent_id: agentId }
    if (title) body.title = title
    let meta
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      meta = await res.json()
    } catch (e) {
      // backend 不到達 / エラー: UI に通知して終了 (ローカルだけ作ると整合性崩れる)
      alert(`セッション作成に失敗しました: ${e?.message || e}`)
      return null
    }
    // 新しい順で並べたいので先頭に挿す
    setSessions(prev => [meta, ...prev])
    setActiveId(meta.id)
    return meta
  }, [])

  const removeSession = useCallback(async (id) => {
    try {
      await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
    } catch { /* backend 未到達でもローカル状態は消す */ }
    // setState はネストせず順番に呼ぶ。 React 18 のバッチングで 1 回の再描画にまとまる
    let nextActive = null
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      // 削除したのが active なら、 残りの先頭 (= 一番新しい) を選び直す
      nextActive = (prev.find(s => s.id === id) && next.length > 0) ? next[0].id : null
      return next
    })
    setActiveId(curActive => {
      if (curActive !== id) return curActive
      return nextActive
    })
  }, [])

  const renameSession = useCallback(async (id, title) => {
    const trimmed = (title || '').trim()
    if (!trimmed) return
    // 楽観更新
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title: trimmed } : s))
    try {
      await fetch(`${API_BASE}/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
    } catch { /* ignore: ローカルは既に反映済み */ }
  }, [])

  return {
    sessions,
    activeId,
    setActiveId,
    agents,
    createSession,
    removeSession,
    renameSession,
  }
}
