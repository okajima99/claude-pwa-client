import { useEffect, useState } from 'react'
import { getImageURL } from '../utils/imageStore.js'

// user メッセージの画像表示。 imageRefs (= IndexedDB の ID 配列) から URL を取り出し、
// 表示中だけ ObjectURL を保持してアンマウント時に revoke する。
// 後方互換: legacy data URL `imageUrls` も併せて受ける。
export default function AttachedImages({ imageRefs, imageUrls }) {
  const [refUrls, setRefUrls] = useState(() => imageRefs?.map(() => null) || [])

  useEffect(() => {
    if (!imageRefs || imageRefs.length === 0) return
    let cancelled = false
    const created = []
    Promise.all(imageRefs.map(id => getImageURL(id).catch(() => null)))
      .then(urls => {
        if (cancelled) {
          urls.forEach(u => u && URL.revokeObjectURL(u))
          return
        }
        urls.forEach(u => { if (u) created.push(u) })
        setRefUrls(urls)
      })
    return () => {
      cancelled = true
      created.forEach(u => URL.revokeObjectURL(u))
    }
  }, [imageRefs])

  const allUrls = [
    ...(imageUrls || []),
    ...(refUrls.filter(Boolean)),
  ]
  if (allUrls.length === 0) return null
  return (
    <div className="attach-images">
      {allUrls.map((url, j) => (
        <img key={j} src={url} className="msg-image" alt="" />
      ))}
    </div>
  )
}
