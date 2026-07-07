import { useState } from 'react'
import { MediaModelsView } from '@/components/media-models'
import { toast } from '@/lib/toast'

export default function AudioPage() {
  const [text, setText] = useState('')
  const [voice, setVoice] = useState('alloy')
  const [isGenerating, setIsGenerating] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) return

    setIsGenerating(true)
    setAudioUrl('')
    try {
      // 1. Gửi request sinh audio
      const response = await fetch('/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
        },
        body: JSON.stringify({
          input: text,
          voice,
          model: 'auto'
        })
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      // 2. Chuyển đổi dữ liệu nhị phân nhận được thành Blob url
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      setAudioUrl(url)
      toast.success('Sinh giọng nói thành công!')
    } catch (err: any) {
      toast.error('Lỗi khi chuyển văn bản: ' + err.message)
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Khung sinh giọng nói trực tiếp */}
      <section className="rounded-3xl border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Trình tạo Giọng nói trực tiếp (Text to Speech)</h2>
        <form onSubmit={handleGenerate} className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <input
              type="text"
              placeholder="Nhập văn bản cần chuyển thành giọng nói (ví dụ: Hello world)..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-full border bg-transparent px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
              required
            />
          </div>
          <div>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="w-full rounded-full border bg-transparent px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
            >
              <option value="alloy">Alloy (Trung tính)</option>
              <option value="echo">Echo (Trầm ấm)</option>
              <option value="fable">Fable (Kể chuyện)</option>
              <option value="onyx">Onyx (Nam trầm)</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={isGenerating}
            className="w-full rounded-full bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
          >
            {isGenerating ? 'Đang chuyển đổi...' : 'Chuyển thành giọng nói'}
          </button>
        </form>

        {audioUrl && (
          <div className="mt-4 flex flex-col items-center space-y-2 p-4 rounded-2xl bg-muted/20 border border-cyan-500/10">
            <audio src={audioUrl} controls className="w-full max-w-md" />
            <a
              href={audioUrl}
              download="generated_speech.mp3"
              className="text-xs text-cyan-400 hover:underline mt-2"
            >
              Tải file Audio về máy (.mp3)
            </a>
          </div>
        )}
      </section>

      {/* Danh sách quản lý mô hình và key */}
      <MediaModelsView modality="audio" />
    </div>
  )
}
