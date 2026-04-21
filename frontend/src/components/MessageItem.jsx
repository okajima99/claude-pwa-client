import { memo } from 'react'
import MessageRenderer from '../MessageRenderer.jsx'
import AskUserQuestionBubble from './AskUserQuestionBubble.jsx'
import { formatToolResultContent, formatCost, formatDuration, formatModelName, formatTokens } from '../utils/format.js'
import { diffLines, compactDiff } from '../utils/diff.js'

const RESULT_PREVIEW_CHARS = 800

// Grep / Glob の結果本文をパスリンク化する。
// Grep content mode: "path:line:content" / files_with_matches: "path"
// Glob: "path" (絶対 or 相対)
// パス判定ゆるめ: 先頭から [:\s] までを path と仮定し、/ を含むか拡張子っぽいものだけリンク化。
function LinkifiedResult({ text, onOpenFile, errorClass }) {
  const lines = text.split('\n')
  return (
    <pre className={`tool-result-text ${errorClass || ''}`}>
      {lines.map((line, i) => {
        // 行頭のパス部分を抽出: 空白とコロンで切る
        const m = line.match(/^([^\s:]+)(.*)$/)
        if (!m) return <div key={i}>{line || ' '}</div>
        const [, pathCandidate, rest] = m
        const looksLikePath = pathCandidate.includes('/') || /\.[a-zA-Z0-9]{1,6}$/.test(pathCandidate)
        if (!looksLikePath || !onOpenFile) {
          return <div key={i}>{line || ' '}</div>
        }
        const handleClick = (e) => {
          e.stopPropagation()
          e.preventDefault()
          onOpenFile(pathCandidate)
        }
        return (
          <div key={i}>
            <span className="file-link" onClick={handleClick} role="link" tabIndex={0}>{pathCandidate}</span>
            {rest}
          </div>
        )
      })}
    </pre>
  )
}

function DiffView({ diffInput }) {
  if (!diffInput) return null
  if (diffInput.kind === 'edit') {
    const ops = compactDiff(diffLines(diffInput.old_string, diffInput.new_string), 2)
    return (
      <div className="diff-view">
        {diffInput.file_path && (
          <div className="diff-path">{diffInput.file_path}{diffInput.replace_all ? ' (replace_all)' : ''}</div>
        )}
        <pre className="diff-body">
          {ops.map((op, i) => (
            <div key={i} className={`diff-line ${op.type}`}>
              <span className="diff-marker">{op.type === 'add' ? '+' : op.type === 'del' ? '-' : op.type === 'gap' ? ' ' : ' '}</span>
              <span className="diff-text">{op.text}</span>
            </div>
          ))}
        </pre>
      </div>
    )
  }
  // write: 新規作成扱いで全行を + で
  if (diffInput.kind === 'write') {
    const lines = String(diffInput.content ?? '').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '' && diffInput.content.endsWith('\n')) lines.pop()
    return (
      <div className="diff-view">
        {diffInput.file_path && (
          <div className="diff-path">{diffInput.file_path} (new file)</div>
        )}
        <pre className="diff-body">
          {lines.map((line, i) => (
            <div key={i} className="diff-line add">
              <span className="diff-marker">+</span>
              <span className="diff-text">{line}</span>
            </div>
          ))}
        </pre>
      </div>
    )
  }
  return null
}

// 通常完了 (end_turn / tool_use) 以外の停止理由をチップで強調表示
const STOP_REASON_LABELS = {
  max_tokens: { label: '⚠ トークン上限で停止', cls: 'warn' },
  refusal: { label: '🚫 拒否されました', cls: 'danger' },
  pause_turn: { label: '⏸ 一時停止', cls: 'info' },
  model_context_window_exceeded: { label: '⚠ コンテキスト窓超過', cls: 'warn' },
}

function StopReasonChip({ meta, streaming }) {
  if (!meta || streaming) return null
  if (meta.is_error) {
    return <div className="stop-chip danger">⚠ エラーで停止{meta.stop_reason ? ` (${meta.stop_reason})` : ''}</div>
  }
  if (!meta.stop_reason || meta.stop_reason === 'end_turn' || meta.stop_reason === 'tool_use') return null
  const def = STOP_REASON_LABELS[meta.stop_reason]
  if (!def) return <div className="stop-chip info">⚠ {meta.stop_reason}</div>
  return <div className={`stop-chip ${def.cls}`}>{def.label}</div>
}

function MetaLine({ meta, streaming, apiKeySource }) {
  if (!meta || streaming) return null
  const parts = []
  // cost は API キー経由（"none" でない）のときだけ表示。OAuth/subscription 経路では参考値で誤解を招くため非表示
  if (apiKeySource && apiKeySource !== 'none') {
    const cost = formatCost(meta.cost_usd)
    if (cost) parts.push(cost)
  }
  const tokens = formatTokens(meta.usage)
  if (tokens) parts.push(tokens)
  // turns は意味が伝わりにくいので非表示
  const dur = formatDuration(meta.duration_ms)
  if (dur) parts.push(dur)
  const model = formatModelName(meta.modelUsage)
  if (model) parts.push(model)
  if (parts.length === 0) return null
  return <div className="bubble-meta">{parts.join(' · ')}</div>
}

const MessageItem = memo(function MessageItem({ msg, onOpenFile, onAnswer, apiKeySource }) {
  if (msg.role === '__loading__') {
    return (
      <div className="message agent">
        <span className="bubble dim">…</span>
      </div>
    )
  }
  // streaming 中で中身がまだゼロ (送信直後〜最初のチャンク到着まで) は「推論中…」を出して
  // 沈黙を埋める。最初のチャンクが届いた瞬間にこの分岐から抜けて通常描画へ移行する。
  if (
    msg.role === 'agent' &&
    msg.streaming &&
    !msg.text &&
    !msg.thinking &&
    !msg.askUserQuestion &&
    !(msg.tools && msg.tools.length > 0)
  ) {
    return (
      <div className="message agent">
        <span className="bubble dim">推論中…</span>
      </div>
    )
  }
  return (
    <div className={`message ${msg.role}`}>
      {msg.role === 'user' && (msg.imageUrls?.length > 0 || msg.fileNames?.length > 0) ? (
        <div className="user-block">
          {msg.imageUrls?.length > 0 && (
            <div className="attach-images">
              {msg.imageUrls.map((url, j) => (
                <img key={j} src={url} className="msg-image" alt="" />
              ))}
            </div>
          )}
          {msg.fileNames?.length > 0 && (
            <div className="attach-files">
              {msg.fileNames.map((name, j) => (
                <span key={j} className="file-chip">📄 {name}</span>
              ))}
            </div>
          )}
          {msg.text && (
            <span className="bubble">
              <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
            </span>
          )}
        </div>
      ) : msg.role === 'agent' && (msg.tools?.length > 0 || msg.thinking || msg.askUserQuestion) ? (
        <div className="agent-block">
          {msg.thinking && (
            <details className="thinking-block">
              <summary>💭 thinking</summary>
              <pre className="thinking-text">{msg.thinking}</pre>
            </details>
          )}
          {msg.tools?.length > 0 && (
            <div className="tool-log">
              {msg.tools.map((t) => {
                const resultText = t.result ? formatToolResultContent(t.result.content) : null
                const truncated = resultText && resultText.length > RESULT_PREVIEW_CHARS
                const hasDiff = !!t.diffInput
                // Read はパスが summary に出てるので input の echo は冗長。tool-input-full は描画しない
                const showInputFull = !hasDiff && t.name !== 'Read' && t.shortLabel && t.shortLabel !== t.label
                const hasMore = hasDiff || showInputFull || !!t.result
                // diff のある Edit/Write は初期展開（ターミナル風に変更点を目視できるように）
                const openByDefault = hasDiff
                return (
                  <details
                    key={t.id}
                    className={`tool-block ${t.result?.is_error ? 'is-error' : ''}`}
                    open={openByDefault}
                  >
                    <summary className={`tool-line tool-${t.name.toLowerCase()}`} title={t.label}>
                      <span className="tool-marker">{hasMore ? '▸' : '·'}</span>
                      <span className="tool-short">{t.shortLabel || t.label}</span>
                      {t.result?.is_error && <span className="tool-err-mark"> ⚠</span>}
                      {resultText && (
                        <span className="tool-meta"> · {resultText.length}文字</span>
                      )}
                    </summary>
                    {hasMore && (
                      <div className="tool-body">
                        {hasDiff ? (
                          <DiffView diffInput={t.diffInput} />
                        ) : showInputFull && (
                          <pre className="tool-input-full">{t.label}</pre>
                        )}
                        {t.result && (() => {
                          const shown = truncated ? resultText.slice(0, RESULT_PREVIEW_CHARS) + '\n…（省略）' : resultText
                          const errorClass = t.result.is_error ? 'is-error' : ''
                          if ((t.name === 'Grep' || t.name === 'Glob') && !t.result.is_error) {
                            return <LinkifiedResult text={shown} onOpenFile={onOpenFile} errorClass={errorClass} />
                          }
                          return (
                            <pre className={`tool-result-text ${errorClass}`}>
                              {shown}
                            </pre>
                          )
                        })()}
                      </div>
                    )}
                  </details>
                )
              })}
              {msg.streaming && <div className="tool-line tool-pending">…</div>}
            </div>
          )}
          {msg.text && (
            <span className="bubble">
              <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
            </span>
          )}
          {msg.askUserQuestion && (
            <AskUserQuestionBubble askUserQuestion={msg.askUserQuestion} onAnswer={onAnswer} />
          )}
          <StopReasonChip meta={msg.meta} streaming={msg.streaming} />
          <MetaLine meta={msg.meta} streaming={msg.streaming} apiKeySource={apiKeySource} />
        </div>
      ) : msg.role === 'agent' ? (
        <div className="agent-block">
          {msg.text && (
            <span className="bubble">
              <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
            </span>
          )}
          <StopReasonChip meta={msg.meta} streaming={msg.streaming} />
          <MetaLine meta={msg.meta} streaming={msg.streaming} apiKeySource={apiKeySource} />
        </div>
      ) : (
        <span className="bubble">
          <MessageRenderer text={msg.text} onOpenFile={onOpenFile} streaming={msg.streaming} />
        </span>
      )}
    </div>
  )
})

export default MessageItem
