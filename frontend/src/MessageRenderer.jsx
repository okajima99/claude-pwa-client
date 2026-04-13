import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'

const PATH_RE = /(?<![(`])(~\/[^\s`"')\]]+|\/Users\/[^\s`"')\]]+)/g

// remarkプラグイン: テキストノード内のファイルパスをlinkノードに変換
function remarkFilePaths() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index == null) return
      PATH_RE.lastIndex = 0
      if (!PATH_RE.test(node.value)) return

      PATH_RE.lastIndex = 0
      const parts = []
      let last = 0
      let match

      while ((match = PATH_RE.exec(node.value)) !== null) {
        if (match.index > last) {
          parts.push({ type: 'text', value: node.value.slice(last, match.index) })
        }
        parts.push({
          type: 'link',
          url: `cpc://${encodeURIComponent(match[0])}`,
          children: [{ type: 'text', value: match[0] }],
        })
        last = match.index + match[0].length
      }
      if (last < node.value.length) {
        parts.push({ type: 'text', value: node.value.slice(last) })
      }

      parent.children.splice(index, 1, ...parts)
    })

    // インラインコード（`~/...`）もリンクに変換
    visit(tree, 'inlineCode', (node, index, parent) => {
      if (!parent || index == null) return
      if (!/^(~\/|\/Users\/)/.test(node.value)) return
      parent.children.splice(index, 1, {
        type: 'link',
        url: `cpc://${encodeURIComponent(node.value)}`,
        children: [{ type: 'text', value: node.value }],
      })
    })
  }
}

export default function MessageRenderer({ text, onOpenFile }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkFilePaths]}
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
      {text}
    </ReactMarkdown>
  )
}
