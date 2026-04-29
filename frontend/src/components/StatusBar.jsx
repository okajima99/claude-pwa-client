import { pctClass, timeUntil } from '../utils/format.js'

// 上部のステータス行: モデル名 / 5h / 7d / ctx 使用率
// resets_at が 0 (未知) の間は生の pct を信用、既知かつ過去なら「窓切れ = 0%」扱い。
export default function StatusBar({ status, nowSec }) {
  if (!status) {
    return (
      <div className="statusbar">
        <span className="dim">---</span>
      </div>
    )
  }
  const expired = status.five_hour_resets_at > 0 && status.five_hour_resets_at < nowSec
  const fivePct = expired ? 0 : status.five_hour_pct
  return (
    <div className="statusbar">
      <span className="model">{status.model}</span>
      <span className={pctClass(fivePct)}>
        5h {Math.round(fivePct)}%{' '}
        <span className="dim">{timeUntil(status.five_hour_resets_at, nowSec)}</span>
      </span>
      <span className={pctClass(status.seven_day_pct)}>7d {Math.round(status.seven_day_pct)}%</span>
      <span className={pctClass(status.ctx_pct)}>ctx {Math.round(status.ctx_pct || 0)}%</span>
    </div>
  )
}
