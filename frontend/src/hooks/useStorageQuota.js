import { useEffect, useState } from 'react'

// navigator.storage.estimate でブラウザの永続ストレージ使用率を取得し、
// 一定間隔で更新する。 値は 0.0〜1.0、 取得失敗時は null。
//
// PWA / iOS の挙動: WKWebView でも storage.estimate は実装済み。 値は
// usage / quota で localStorage + IndexedDB + cache 全部含む合算。
// quota が知れないブラウザもあるので null を許容する形で返す。
//
// 警告ポリシー (App 側で使う):
// - ratio >= 0.85: 警告バナー表示
// - 0.85 未満になるまで隠さない (ヒステリシスなし、 単純比較で OK)
const POLL_INTERVAL_MS = 60 * 1000

export function useStorageQuota() {
  const [info, setInfo] = useState(null) // { ratio, usage, quota } or null

  useEffect(() => {
    let cancelled = false

    const measure = async () => {
      if (cancelled) return
      try {
        if (!navigator.storage || !navigator.storage.estimate) {
          setInfo(null)
          return
        }
        const est = await navigator.storage.estimate()
        if (cancelled) return
        const usage = est.usage || 0
        const quota = est.quota || 0
        const ratio = quota > 0 ? usage / quota : 0
        setInfo({ ratio, usage, quota })
      } catch {
        // ignore (Safari の private mode 等は estimate が失敗する)
      }
    }

    measure()
    const id = setInterval(measure, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return info
}
