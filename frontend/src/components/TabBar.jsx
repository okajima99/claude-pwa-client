import { AGENTS } from '../constants.js'

// 上部のエージェントタブ。display_name が無ければ大文字のエージェント ID で表示。
// tabBadges[agent] が { kind, label } を返したらバッジを並べる。
export default function TabBar({ activeAgent, setActiveAgent, displayNames, tabBadges }) {
  return (
    <div className="tabs">
      {AGENTS.map(agent => {
        const badge = tabBadges[agent]
        return (
          <button
            key={agent}
            className={`tab ${activeAgent === agent ? 'active' : ''}`}
            onClick={() => {
              setActiveAgent(agent)
              try { localStorage.setItem('cpc_active_agent', agent) } catch { /* ignore */ }
            }}
          >
            {displayNames[agent] || agent.toUpperCase()}
            {badge && <span className={`tab-badge ${badge.kind}`}>{badge.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
