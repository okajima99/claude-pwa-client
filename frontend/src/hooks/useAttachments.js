import { useState, useRef, useEffect, useCallback } from 'react'
import { SUPPORTED_IMAGE_TYPES } from '../constants.js'

// セッション (session_id) ごとの添付ファイル状態。 dict は lazy 拡張する。
export function useAttachments(activeSession) {
  const [attachments, setAttachments] = useState({})
  const fileInputRef = useRef(null)
  const attachmentsRef = useRef(attachments)

  useEffect(() => { attachmentsRef.current = attachments }, [attachments])

  // アンマウント時に未送信 BlobURL を解放 (全セッション分)
  useEffect(() => {
    return () => {
      const dict = attachmentsRef.current
      for (const sid of Object.keys(dict)) {
        for (const item of dict[sid] || []) {
          if (item.url) URL.revokeObjectURL(item.url)
        }
      }
    }
  }, [])

  const handleFileSelect = (e) => {
    const sid = activeSession?.id
    if (!sid) return
    const newItems = Array.from(e.target.files || []).map(file => ({
      file,
      url: SUPPORTED_IMAGE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null,
    }))
    setAttachments(prev => ({
      ...prev,
      [sid]: [...(prev[sid] || []), ...newItems],
    }))
    e.target.value = ''
  }

  const removeAttachment = (sid, index) => {
    setAttachments(prev => {
      const cur = [...(prev[sid] || [])]
      const removed = cur.splice(index, 1)
      if (removed[0]?.url) URL.revokeObjectURL(removed[0].url)
      return { ...prev, [sid]: cur }
    })
  }

  const clearAttachments = useCallback((sid) => {
    setAttachments(prev => ({ ...prev, [sid]: [] }))
  }, [])

  return {
    attachments,
    fileInputRef,
    handleFileSelect,
    removeAttachment,
    clearAttachments,
  }
}
