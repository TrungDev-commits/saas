import { useState, useEffect } from 'react'
import { PageHeader } from '@/components/page-header'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { CardSkeleton } from '@/components/ui/skeleton'

interface Document {
  id: number
  filename: string
  created_at: string
}

interface Source {
  content: string
  filename: string
  similarity: number
}

export default function DocsQAPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filename, setFilename] = useState('')
  const [content, setContent] = useState('')
  const [isUploading, setIsUploading] = useState(false)

  // Chat states
  const [query, setQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [answer, setAnswer] = useState('')
  const [sources, setSources] = useState<Source[]>([])

  useEffect(() => {
    fetchDocuments()
  }, [])

  async function fetchDocuments() {
    try {
      const res = await apiFetch<{ documents: Document[] }>('/api/rag/documents')
      setDocuments(res.documents || [])
    } catch (err: any) {
      toast.error('Không thể lấy danh sách tài liệu: ' + err.message)
    } finally {
      setIsLoading(false)
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!filename.trim() || !content.trim()) return

    setIsUploading(true)
    try {
      await apiFetch('/api/rag/upload', {
        method: 'POST',
        body: JSON.stringify({ filename, content }),
      })
      toast.success('Tải lên tài liệu thành công!')
      setFilename('')
      setContent('')
      fetchDocuments()
    } catch (err: any) {
      toast.error('Lỗi upload: ' + err.message)
    } finally {
      setIsUploading(false)
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Bạn chắc chắn muốn xóa tài liệu này?')) return
    try {
      await apiFetch(`/api/rag/documents/${id}`, { method: 'DELETE' })
      toast.success('Đã xóa tài liệu')
      fetchDocuments()
    } catch (err: any) {
      toast.error('Lỗi khi xóa: ' + err.message)
    }
  }

  async function handleQuery(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return

    setIsSearching(true)
    setAnswer('')
    setSources([])
    try {
      // 1. Thực hiện Semantic Search
      const searchRes = await apiFetch<{ context: Source[] }>('/api/rag/query', {
        method: 'POST',
        body: JSON.stringify({ query }),
      })

      const contextChunks = searchRes.context
      setSources(contextChunks)

      if (contextChunks.length === 0) {
        setAnswer('Không tìm thấy tài liệu nào liên quan đến câu hỏi của bạn.')
        setIsSearching(false)
        return
      }

      // 2. Tạo prompt đưa ngữ cảnh vào và gọi chat proxy
      const contextText = contextChunks.map((c, idx) => `[Tài liệu ${idx + 1}: ${c.filename}]\n${c.content}`).join('\n\n')
      const systemPrompt = `Bạn là Trợ lý Hỏi Đáp dựa vào Tài liệu. Bạn CHỈ ĐƯỢC PHÉP trả lời các câu hỏi dựa trên thông tin ngữ cảnh (Context) được cung cấp dưới đây. Nếu thông tin không có trong ngữ cảnh, hãy lịch sự từ chối trả lời hoặc nói rằng bạn không tìm thấy thông tin trong tài liệu đã cung cấp. Không tự ý bịa đặt thông tin ngoài ngữ cảnh.\n\n[CONTEXT]\n${contextText}`

      // Gọi API chat completions qua proxy
      const chatRes = await apiFetch<{ choices: { message: { content: string } }[] }>('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'auto',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query }
          ]
        })
      })

      const reply = chatRes.choices?.[0]?.message?.content || 'Không nhận được câu trả lời từ mô hình.'
      setAnswer(reply)
    } catch (err: any) {
      toast.error('Lỗi khi truy vấn: ' + err.message)
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Hỏi đáp Tài liệu (RAG)" description="Tải tài liệu lên và nhận câu trả lời bảo mật tuyệt đối chỉ dựa vào nội dung tài liệu." divider={true} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Upload và List Tài liệu */}
        <div className="space-y-6 lg:col-span-1">
          <section className="rounded-3xl border bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Thêm tài liệu mới</h2>
            <form onSubmit={handleUpload} className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Tên tài liệu</label>
                <input
                  type="text"
                  placeholder="Ví dụ: Quy trinh trien khai.txt"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  required
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Nội dung tài liệu</label>
                <textarea
                  placeholder="Dán nội dung văn bản vào đây để AI phân tích..."
                  rows={6}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={isUploading}
                className="w-full rounded-full bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
              >
                {isUploading ? 'Đang tạo vector...' : 'Tải lên & Vector hóa'}
              </button>
            </form>
          </section>

          <section className="rounded-3xl border bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Tài liệu đã học ({documents.length})</h2>
            {isLoading ? (
              <CardSkeleton />
            ) : documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có tài liệu nào.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {documents.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between p-2 rounded bg-muted/30">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{doc.filename}</p>
                      <p className="text-[10px] text-muted-foreground">{new Date(doc.created_at).toLocaleString()}</p>
                    </div>
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="text-[10px] text-red-500 hover:text-red-400 ml-2"
                    >
                      Xóa
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Khung chat hỏi đáp */}
        <div className="lg:col-span-2 space-y-6">
          <section className="rounded-3xl border bg-card p-5 space-y-4 min-h-[400px] flex flex-col">
            <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Khung Q&A Thông minh</h2>

            <form onSubmit={handleQuery} className="flex gap-2">
              <input
                type="text"
                placeholder="Hỏi bất kỳ điều gì dựa trên các tài liệu đã tải lên..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 rounded-full border bg-transparent px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                required
              />
              <button
                type="submit"
                disabled={isSearching}
                className="rounded-full bg-cyan-600 px-6 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
              >
                {isSearching ? 'Đang tìm kiếm...' : 'Hỏi AI'}
              </button>
            </form>

            <div className="flex-1 space-y-4 overflow-y-auto p-2 bg-muted/10 rounded-2xl">
              {isSearching && (
                <div className="space-y-2 animate-pulse">
                  <div className="h-4 bg-muted rounded w-3/4"></div>
                  <div className="h-4 bg-muted rounded w-1/2"></div>
                </div>
              )}

              {answer && (
                <div className="space-y-3">
                  <div className="p-4 rounded-2xl bg-muted/40 border border-cyan-500/10 text-xs leading-relaxed whitespace-pre-wrap">
                    {answer}
                  </div>

                  {/* Hiển thị nguồn */}
                  {sources.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">Trích nguồn liên quan:</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {sources.map((s, idx) => (
                          <div key={idx} className="p-2.5 rounded-lg border bg-card/60 text-[11px]">
                            <p className="font-semibold text-cyan-400 truncate mb-1">
                              Doc: {s.filename} (Kớp {Math.round(s.similarity * 100)}%)
                            </p>
                            <p className="text-muted-foreground line-clamp-3">{s.content}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!answer && !isSearching && (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 text-muted-foreground space-y-2">
                  <p className="text-xs">Chưa có câu hỏi nào được thực hiện.</p>
                  <p className="text-[10px]">Tải lên tài liệu bên trái và bắt đầu hỏi đáp ngữ cảnh.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
