// VITE_API_BASE が未設定 (undefined) のときだけ localhost フォールバック。
// 空文字 ('') を明示すると同一オリジン相対 (= PWA を配信したホスト) になる。
// 同一オリジン相対にしておくと http/https 両方の URL から問題なく API が叩ける。
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const MAX_MESSAGES = 200

// localStorage キー
export const LS_SESSIONS_META = 'cpc_sessions_meta'   // [{id, agent_id, title, created_at}, ...]
export const LS_ACTIVE_SESSION = 'cpc_active_session'  // 現在表示中の session_id
export const LS_MESSAGES = 'cpc_messages'              // {session_id: [...]} (LZString 圧縮)
export const LS_INPUT = 'cpc_input'                    // {session_id: 入力中文字列}
// 旧キー (マイグレーション用)
export const LS_LEGACY_ACTIVE_AGENT = 'cpc_active_agent'
