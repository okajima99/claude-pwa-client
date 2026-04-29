import { useState, useRef, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { API_BASE, AGENTS, MAX_MESSAGES } from '../constants.js'
import { generateId } from '../utils/id.js'
import { fileToBase64 } from '../utils/file.js'
import { describeError } from '../utils/format.js'
import { useStreamBuffer } from './internal/useStreamBuffer.js'
import { useStreamReconnect } from './internal/useStreamReconnect.js'
import { processStreamEvent } from './internal/processStreamEvent.js'

// チャット 1 ターンの送受信・再接続・状態管理を束ねた公開フック。
// 内部は機能ブロックごとに以下に分かれている:
//   internal/useStreamBuffer.js     rAF batching
//   internal/processStreamEvent.js  SSE イベント → state 反映 (純粋関数)
//   internal/useStreamReconnect.js  reconnect / visibility 復帰
// このフック自身は send / answer / stop / endSession の各アクションを提供する。
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
  const loadingRef = useRef(loading)
  useEffect(() => { loadingRef.current = loading }, [loading])

  // fetchLatest は内部 hook から activeAgent を参照したいが、依存配列で再生成すると
  // event listener が貼り直しになる。ref で「最新の activeAgent」を持ち回す。
  const activeAgentRef = useRef(activeAgent)
  useEffect(() => { activeAgentRef.current = activeAgent }, [activeAgent])

  // 送信世代カウンタ。stop → 新 send の race で「古い send の finally が新 send の状態
  // (loading / streaming flag / 最後のバブル / streamBuf) を巻き込んで壊す」のを防ぐ。
  // 新 send は myGen++ で世代を進める。古い finally は myGen が最新かを await の前後で
  // 確認し、世代が古ければ何もせず抜ける。
  const sendGenRef = useRef({ agent_a: 0, agent_b: 0 })

  const buffer = useStreamBuffer({ setMessages })

  const reconnect = useStreamReconnect({
    setMessages,
    setLoading,
    setApiKeySource,
    buffer,
    scrollToBottom,
    isAtBottomRef,
    loadingRef,
    abortControllers,
    activeAgentRef,
  })

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
    buffer.resetBuf(agent)

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
      let buf = ''

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
            processStreamEvent(reconnect.eventDeps, agent, JSON.parse(data))
          } catch { /* ignored */ }
        }
      }

      // SSEが静かに切れた場合の復旧: サーバーがまだ streaming 中なら追いかける
      if (await reconnect.reconnectIfStreaming(agent)) return
    } catch (e) {
      if (e.name === 'AbortError') return
      // 自分が「過去の send」になっていたらエラー表示も新 send の世界を汚すので何もしない
      if (!isCurrentGen()) return
      const errText = describeError(e)
      // 通信失敗時: reconnectで取り戻せれば続行、ダメならエラー表示
      const recovered = await reconnect.reconnectIfStreaming(agent)
      if (!recovered) {
        if (!isCurrentGen()) return
        // バッファ未反映の text/tools があると last の判定をすり抜け、余計なエラーバブルが
        // 追加されたあと後段の flush で内容が復活して二重表示になる。先に確定させる。
        buffer.cancelAndFlush(agent)
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
        buffer.cancelAndFlush(agent)
        if (!reconnect.reconnectingRef.current[agent]) {
          const handledByReconnect = await reconnect.reconnectIfStreaming(agent)
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
    buffer.cancelAndFlush(agent)
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
    fetchLatest: reconnect.fetchLatest,
    endSession,
  }
}
