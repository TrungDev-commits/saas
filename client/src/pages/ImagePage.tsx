import { useState } from 'react'
import { MediaModelsView } from '@/components/media-models'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'

export default function ImagePage() {
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [isGenerating, setIsGenerating] = useState(false)
  const [imageUrl, setImageUrl] = useState('')

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault()
    if (!prompt.trim()) return

    setIsGenerating(true)
    setImageUrl('')
    try {
      const res = await apiFetch<{ data: { url?: string; b64_json?: string }[] }>('/v1/images/generations', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          size,
          model: 'auto'
        })
      })

      const imgData = res.data?.[0]
      if (imgData?.url) {
        setImageUrl(imgData.url)
      } else if (imgData?.b64_json) {
        setImageUrl(`data:image/png;base64,${imgData.b64_json}`)
      } else {
        toast.error('Mô hình không trả về ảnh.')
      }
    } catch (err: any) {
      toast.error('Lỗi khi sinh ảnh: ' + err.message)
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Khung tạo ảnh trực tiếp */}
      <section className="rounded-3xl border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Trình tạo Ảnh trực tiếp (Text to Image)</h2>
        <form onSubmit={handleGenerate} className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <input
              type="text"
              placeholder="Nhập mô tả ảnh bạn muốn tạo (ví dụ: A futuristic cyberpunk city)..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full rounded-full border bg-transparent px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
              required
            />
          </div>
          <div>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="w-full rounded-full border bg-transparent px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
            >
              <option value="1024x1024">1024x1024 (1:1)</option>
              <option value="512x512">512x512 (1:1 nhỏ)</option>
              <option value="768x1024">768x1024 (3:4)</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={isGenerating}
            className="w-full rounded-full bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
          >
            {isGenerating ? 'Đang vẽ...' : 'Tạo Ảnh'}
          </button>
        </form>

        {imageUrl && (
          <div className="mt-4 flex flex-col items-center space-y-2">
            <img
              src={imageUrl}
              alt="Generated Result"
              className="max-w-full md:max-w-lg rounded-2xl border shadow-lg"
            />
            <a
              href={imageUrl}
              download="generated_image.png"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-cyan-400 hover:underline"
            >
              Mở trong tab mới / Tải về
            </a>
          </div>
        )}
      </section>

      {/* Danh sách quản lý mô hình và key */}
      <MediaModelsView modality="image" />
    </div>
  )
}
