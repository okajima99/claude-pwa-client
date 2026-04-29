// Web Push 通知の登録/解除ヘルパ。
// iOS PWA は 16.4+ かつホーム画面追加済み (display:standalone) でのみ動作する。

import { API_BASE } from '../constants.js'

const ENABLED_KEY = 'cpc_push_enabled'

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function isStandalone() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
  // iOS Safari fallback
  return !!window.navigator.standalone
}

export function isPushEnabledLocally() {
  try { return localStorage.getItem(ENABLED_KEY) === '1' } catch { return false }
}

function setEnabledFlag(on) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1')
    else localStorage.removeItem(ENABLED_KEY)
  } catch { /* ignore */ }
}

// VAPID 公開鍵 (base64url) → Uint8Array (applicationServerKey 形式)
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null
  return await navigator.serviceWorker.ready
}

export async function enablePush() {
  if (!isPushSupported()) throw new Error('Push 通知に対応していません')
  if (!isStandalone()) {
    throw new Error('iOS では「ホーム画面に追加」した PWA でのみ通知を受け取れます')
  }

  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('通知が許可されませんでした')

  const keyRes = await fetch(`${API_BASE}/push/vapid-public-key`)
  if (!keyRes.ok) throw new Error('サーバ側の VAPID 鍵が未設定です')
  const { public_key } = await keyRes.json()
  if (!public_key) throw new Error('VAPID 公開鍵が空です')

  const reg = await getRegistration()
  if (!reg) throw new Error('Service Worker が登録されていません')

  // 既存サブスクリプションがあれば再利用 (鍵変更時のみ作り直し)
  let sub = await reg.pushManager.getSubscription()
  if (sub) {
    // 鍵不一致なら一度解除
    const existingKey = sub.options && sub.options.applicationServerKey
    if (!existingKey || !buffersEqual(existingKey, urlBase64ToUint8Array(public_key))) {
      await sub.unsubscribe().catch(() => {})
      sub = null
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(public_key),
    })
  }

  const res = await fetch(`${API_BASE}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  })
  if (!res.ok) throw new Error('サーバへのサブスクリプション登録に失敗')

  setEnabledFlag(true)
  return true
}

export async function disablePush() {
  const reg = await getRegistration()
  if (!reg) { setEnabledFlag(false); return }
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    try {
      await fetch(`${API_BASE}/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
    } catch { /* ignore */ }
    await sub.unsubscribe().catch(() => {})
  }
  setEnabledFlag(false)
}

function buffersEqual(a, b) {
  const av = a instanceof ArrayBuffer ? new Uint8Array(a) : a
  const bv = b instanceof ArrayBuffer ? new Uint8Array(b) : b
  if (av.byteLength !== bv.byteLength) return false
  for (let i = 0; i < av.byteLength; i++) if (av[i] !== bv[i]) return false
  return true
}
