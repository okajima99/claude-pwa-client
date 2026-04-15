import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'

SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('toml', toml)
SyntaxHighlighter.registerLanguage('bash', bash)

const EXT_TO_LANG = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  html: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'bash',
}

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

export default function FilePreviewModal({ path, onClose }) {
  const [content, setContent] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const ext = (path.includes('.') ? path.split('.').pop() : '').toLowerCase()
  const isMarkdown = /\.(md|mdx)$/i.test(path)
  const lang = EXT_TO_LANG[ext] || null

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setContent(null)
    fetch(`${API_BASE}/file?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(r => {
        if (r.status === 413) return r.json().then(d => Promise.reject(d.detail || 'ファイルが大きすぎます'))
        return r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)
      })
      .then(data => setContent(data.content))
      .catch(e => { if (e.name !== 'AbortError') setError(typeof e === 'string' ? e : `読み込みエラー`) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [path])

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
            ) : lang ? (
              <SyntaxHighlighter
                language={lang}
                style={oneDark}
                customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', background: 'transparent' }}
                showLineNumbers
              >
                {content}
              </SyntaxHighlighter>
            ) : (
              <pre className="file-content">{content}</pre>
            )
          )}
        </div>
      </div>
    </div>
  )
}
