export function formatTool(block) {
  const { id, name, input } = block
  let label = ''
  switch (name) {
    case 'Bash':
      label = `$ ${input?.command ?? ''}`
      break
    case 'Read':
      label = `read  ${input?.file_path ?? ''}`
      break
    case 'Write':
      label = `write ${input?.file_path ?? ''}`
      break
    case 'Edit':
      label = `edit  ${input?.file_path ?? ''}`
      break
    case 'Glob':
      label = `glob  ${input?.pattern ?? ''}`
      break
    case 'Grep':
      label = `grep  ${input?.pattern ?? ''}`
      break
    default:
      label = `[${name}] ${JSON.stringify(input ?? {})}`
  }
  return { id, name, label }
}

export function formatCost(usd) {
  if (usd == null || typeof usd !== 'number' || usd <= 0) return null
  if (usd < 0.001) return `$${usd.toFixed(5)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}

export function formatDuration(ms) {
  if (ms == null || typeof ms !== 'number' || ms <= 0) return null
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return `${m}m${s}s`
}

function formatTokenCount(n) {
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

export function formatTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const inp = usage.input_tokens || 0
  const out = usage.output_tokens || 0
  const cache = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
  if (!inp && !out && !cache) return null
  const parts = []
  if (inp) parts.push(`in ${formatTokenCount(inp)}`)
  if (cache) parts.push(`cache ${formatTokenCount(cache)}`)
  if (out) parts.push(`out ${formatTokenCount(out)}`)
  return parts.join(' · ')
}

export function formatModelName(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  const key = Object.keys(modelUsage)[0]
  if (!key) return null
  // claude-opus-4-5-... → Opus / claude-sonnet-4-7-... → Sonnet のようにモデル系統名のみ
  // (バージョンまで出すと iPhone で折り返すため省略)
  const stripped = key.replace(/^claude-/, '')
  const parts = stripped.split('-')
  if (parts.length >= 1 && parts[0]) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  }
  return key
}

export function formatToolResultContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (b?.type === 'text') return b.text ?? ''
        if (b?.type === 'image') return '[画像]'
        return JSON.stringify(b)
      })
      .join('\n')
  }
  return JSON.stringify(content)
}

export function describeError(e) {
  if (!navigator.onLine) return 'オフライン'
  if (e?.name === 'TimeoutError') return 'タイムアウト'
  if (e instanceof TypeError) return 'ネットワークエラー（サーバーに接続できません）'
  if (e?.message) return `エラー: ${e.message}`
  return '送信失敗'
}

export function pctClass(pct) {
  if (pct >= 80) return 'pct red'
  if (pct >= 50) return 'pct yellow'
  return 'pct green'
}

export function timeUntil(unixSec) {
  const now = Date.now() / 1000
  let resetAt = unixSec
  if (resetAt < now) {
    const periods = Math.ceil((now - resetAt) / (5 * 3600))
    resetAt += periods * 5 * 3600
  }
  const diff = Math.max(0, resetAt - now)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}
