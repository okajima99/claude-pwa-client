// 添付画像を IndexedDB に Blob で保存して、 message には参照 ID だけ保持する。
// data URL を localStorage に詰めると LZString 圧縮コストと quota 圧迫が大きくなるため、
// blob 保管 + 都度 objectURL 化に切り替える。
//
// 設計:
//   DB: cpc_images
//   ObjectStore: images (key = imageId, value = { blob, mime, createdAt })
//
//   - putImage(file): File → Blob で保存 → 生成した imageId を返す
//   - getImageURL(id): blob を取り出して URL.createObjectURL で URL 化
//     使い終わった URL は呼び出し側で revokeObjectURL する責任
//   - deleteImage(id): 1 件削除
//   - listImageIds(): 全 ID 列挙 (GC 用)
//   - gcImages(activeIds): activeIds に無い ID を全削除

const DB_NAME = 'cpc_images'
const DB_VERSION = 1
const STORE = 'images'

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE) // key を外部指定
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txStore(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

function genImageId() {
  // 32 hex chars。 衝突確率は無視できる
  if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '')
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export async function putImage(file) {
  const db = await openDB()
  const id = genImageId()
  const record = {
    blob: file,
    mime: file.type || 'application/octet-stream',
    createdAt: Date.now(),
  }
  await new Promise((resolve, reject) => {
    const req = txStore(db, 'readwrite').put(record, id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  return id
}

export async function getImageURL(id) {
  const db = await openDB()
  const rec = await new Promise((resolve, reject) => {
    const req = txStore(db, 'readonly').get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  if (!rec || !rec.blob) return null
  return URL.createObjectURL(rec.blob)
}

export async function deleteImage(id) {
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const req = txStore(db, 'readwrite').delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function listImageIds() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = txStore(db, 'readonly').getAllKeys()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

// activeIds に含まれない ID を全部消す。 messages から imageRefs を集めて呼ぶ想定。
export async function gcImages(activeIds) {
  const active = new Set(activeIds)
  const all = await listImageIds()
  const toDelete = all.filter(id => !active.has(id))
  for (const id of toDelete) {
    try { await deleteImage(id) } catch { /* ignore */ }
  }
  return toDelete.length
}
