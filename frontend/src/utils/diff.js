// 軽量な line-based diff (LCS)。外部依存なし。
// 返り値: [{ type: 'ctx'|'add'|'del', text: string }]

function splitLines(s) {
  if (s == null) return []
  // 末尾の空行を作らないために trailing \n を単純には split しない
  const lines = String(s).split('\n')
  // 末尾が空で、元テキストが \n で終わる場合はその空行は削除（表示ノイズ回避）
  if (lines.length > 0 && lines[lines.length - 1] === '' && String(s).endsWith('\n')) {
    lines.pop()
  }
  return lines
}

// LCS (Longest Common Subsequence) の長さテーブルを作る。
// dp[i][j] = a[0..i) と b[0..j) の共通部分列長。後で ops を逆算するのに使う。
function lcsTable(a, b) {
  const n = a.length, m = b.length
  // メモリ節約のため Uint32Array を使う（最大 2.1B まで）
  const dp = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]
    }
  }
  return dp
}

export function diffLines(oldText, newText) {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  // 大きすぎる場合は全削除/全追加で手抜き（UIが固まるのを防ぐ）
  if (a.length * b.length > 2_000_000) {
    const out = []
    for (const line of a) out.push({ type: 'del', text: line })
    for (const line of b) out.push({ type: 'add', text: line })
    return out
  }
  const dp = lcsTable(a, b)
  const ops = []
  let i = a.length, j = b.length
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: 'ctx', text: a[i - 1] })
      i--; j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'del', text: a[i - 1] })
      i--
    } else {
      ops.push({ type: 'add', text: b[j - 1] })
      j--
    }
  }
  while (i > 0) { ops.push({ type: 'del', text: a[--i] }) }
  while (j > 0) { ops.push({ type: 'add', text: b[--j] }) }
  ops.reverse()
  return ops
}

// 前後の ctx を N 行だけ残し、差分周辺だけ見せる（長いファイル対応）
export function compactDiff(ops, contextLines = 3) {
  if (ops.length === 0) return ops
  // どの index が add/del か
  const changed = new Array(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'ctx') changed[i] = true
  }
  // keep[i] = その ctx 行を残すか
  const keep = new Array(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (changed[i]) {
      keep[i] = true
      for (let k = 1; k <= contextLines; k++) {
        if (i - k >= 0) keep[i - k] = true
        if (i + k < ops.length) keep[i + k] = true
      }
    }
  }
  const result = []
  let gapSkipped = 0 // 飛ばされた ctx 行数 (行番号計算に使う)
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      if (gapSkipped > 0) {
        result.push({ type: 'gap', text: '…', skippedLines: gapSkipped })
        gapSkipped = 0
      }
      result.push(ops[i])
    } else {
      gapSkipped++
    }
  }
  return result
}
