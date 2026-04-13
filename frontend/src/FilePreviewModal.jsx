import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

export default function FilePreviewModal({ path, onClose }) {
  const [content, setContent] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const isMarkdown = /\.(md|mdx)$/i.test(path)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/file?path=${encodeURIComponent(path)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setContent(data.content))
      .catch(e => setError(`読み込みエラー (${e})`))
      .finally(() => setLoading(false))
  }, [path])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-path">{path}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {loading && <span className="dim">読み込み中...</span>}
          {error && <span className="error">{error}</span>}
          {content !== null && (
            isMarkdown ? (
              <div className="md-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="file-content">{content}</pre>
            )
          )}
        </div>
      </div>
    </div>
  )
}
