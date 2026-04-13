import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PATH_PLAIN_RE = /(~\/[^\s`"')\]]+|\/Users\/[^\s`"')\]]+)/g
const PATH_BACKTICK_RE = /`(~\/[^`\s]+|\/Users\/[^`\s]+)`/g

function preprocessPaths(text) {
  // バッククォート囲みのパスを先に変換（`~/...` → [~/...](cpc://...)）
  let result = text.replace(PATH_BACKTICK_RE, (_, path) =>
    `[${path}](cpc://${encodeURIComponent(path)})`
  )
  // 残りのプレーンなパスを変換（すでにリンク化済みは除く）
  result = result.replace(PATH_PLAIN_RE, (match, offset, str) => {
    // 直前が ] や ( ならすでにリンク内なのでスキップ
    const before = str[offset - 1]
    if (before === '(' || before === ']') return match
    return `[${match}](cpc://${encodeURIComponent(match)})`
  })
  return result
}

export default function MessageRenderer({ text, onOpenFile, markdown }) {
  if (!markdown) {
    const parts = []
    let last = 0
    let match
    PATH_PLAIN_RE.lastIndex = 0
    while ((match = PATH_PLAIN_RE.exec(text)) !== null) {
      if (match.index > last) parts.push(text.slice(last, match.index))
      const p = match[0]
      parts.push(
        <span key={match.index} className="file-link" onClick={() => onOpenFile(p)}>{p}</span>
      )
      last = match.index + p.length
    }
    if (last < text.length) parts.push(text.slice(last))
    return <span style={{ whiteSpace: 'pre-wrap' }}>{parts}</span>
  }

  const processed = preprocessPaths(text)

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        a({ href, children }) {
          if (href?.startsWith('cpc://')) {
            const path = decodeURIComponent(href.slice('cpc://'.length))
            return (
              <span className="file-link" onClick={() => onOpenFile(path)}>
                {children}
              </span>
            )
          }
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>
        },
        pre({ children }) {
          return <pre className="md-code">{children}</pre>
        },
        code({ className, children }) {
          if (!className) return <code className="inline-code">{children}</code>
          return <code className={className}>{children}</code>
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  )
}
