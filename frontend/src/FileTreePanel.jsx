import { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
const HOME = '~'

export default function FileTreePanel({ onOpenFile, onClose, initialPath }) {
  const [currentPath, setCurrentPath] = useState(initialPath || HOME)
  const [entries, setEntries] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadDir(initialPath || HOME)
  }, [])

  const loadDir = (path) => {
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/files/tree?path=${encodeURIComponent(path)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        setCurrentPath(data.path)
        setEntries(data.entries)
      })
      .catch(e => setError(`読み込みエラー (${e})`))
      .finally(() => setLoading(false))
  }

  const handleEntry = (entry) => {
    if (entry.is_dir) {
      setHistory(prev => [...prev, currentPath])
      loadDir(entry.path)
    } else {
      onOpenFile(entry.path)
    }
  }

  const handleBack = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory(h => h.slice(0, -1))
    loadDir(prev)
  }

  const displayPath = currentPath.replace(/^\/Users\/[^/]+/, '~')

  return (
    <div className="tree-overlay" onClick={onClose}>
      <div className="tree-panel" onClick={e => e.stopPropagation()}>
        <div className="tree-header">
          <div className="tree-nav">
            <button className="tree-back" onClick={handleBack} disabled={history.length === 0}>←</button>
            <span className="tree-path">{displayPath}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="tree-body">
          {loading && <span className="dim tree-loading">読み込み中...</span>}
          {error && <span className="error tree-loading">{error}</span>}
          {entries.map(entry => (
            <div
              key={entry.path}
              className={`tree-entry ${entry.is_dir ? 'dir' : 'file'}`}
              onClick={() => handleEntry(entry)}
            >
              <span className="tree-icon">{entry.is_dir ? '📁' : '📄'}</span>
              <span className="tree-name">{entry.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
