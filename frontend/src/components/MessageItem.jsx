import { memo } from 'react'
import MessageRenderer from '../MessageRenderer.jsx'
import { formatToolResultContent } from '../utils/format.js'

const RESULT_PREVIEW_CHARS = 800

const MessageItem = memo(function MessageItem({ msg, onOpenFile }) {
  if (msg.role === '__loading__') {
    return (
      <div className="message agent">
        <span className="bubble dim">…</span>
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
      ) : msg.role === 'agent' && (msg.tools?.length > 0 || msg.thinking) ? (
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
                return (
                  <div key={t.id} className="tool-block">
                    <div className={`tool-line tool-${t.name.toLowerCase()}`}>
                      {t.label}
                    </div>
                    {t.result && (
                      <details className={`tool-result ${t.result.is_error ? 'is-error' : ''}`}>
                        <summary>
                          {t.result.is_error ? '⚠ tool error' : '結果'}
                          {resultText ? ` · ${resultText.length}文字` : ''}
                        </summary>
                        <pre className="tool-result-text">
                          {truncated ? resultText.slice(0, RESULT_PREVIEW_CHARS) + '\n…（省略）' : resultText}
                        </pre>
                      </details>
                    )}
                  </div>
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
