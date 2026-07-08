import { useState, useEffect, useRef } from 'react'
import { PageHeader } from '@/components/page-header'
import { apiFetch, getToken } from '@/lib/api'
import { toast } from '@/lib/toast'
import { CardSkeleton } from '@/components/ui/skeleton'

interface Document {
  id: string
  filename: string
  created_at: string
}

interface Source {
  content: string
  filename: string
  similarity: number
}

interface ChatSession {
  id: string
  title: string
  type: string
  model?: string
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id?: string
  role: string
  content: string
  sourcesJson?: string
}

export default function DocsQAPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filename, setFilename] = useState('')
  const [content, setContent] = useState('')
  const [isUploading, setIsUploading] = useState(false)

  // Chat states
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sources, setSources] = useState<Source[]>([])

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchDocuments()
    fetchSessions()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isSearching])

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

  async function fetchSessions() {
    try {
      const res = await apiFetch<{ sessions: ChatSession[] }>('/api/chat/history/sessions?type=docs-qa')
      setSessions(res.sessions || [])
    } catch (err: any) {
      console.error('Không thể lấy lịch sử chat:', err)
    }
  }

  async function loadSession(sessionId: string) {
    setIsSearching(true)
    setSources([])
    try {
      const res = await apiFetch<{ session: ChatSession & { messages: ChatMessage[] } }>(`/api/chat/history/sessions/${sessionId}`)
      if (res.session) {
        setCurrentSessionId(res.session.id)
        setMessages(res.session.messages)
        
        // Trích nguồn từ tin nhắn trợ lý cuối cùng nếu có
        const assistantMsgs = res.session.messages.filter(m => m.role === 'assistant' && m.sourcesJson)
        if (assistantMsgs.length > 0) {
          const lastMsg = assistantMsgs[assistantMsgs.length - 1];
          try {
            setSources(JSON.parse(lastMsg.sourcesJson || '[]'))
          } catch {
            setSources([])
          }
        }
      }
    } catch (err: any) {
      toast.error('Không thể tải lịch sử chat: ' + err.message)
    } finally {
      setIsSearching(false)
    }
  }

  async function startNewSession() {
    setCurrentSessionId(null)
    setMessages([])
    setSources([])
    setQuery('')
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

  async function handleDelete(id: string) {
    if (!confirm('Bạn chắc chắn muốn xóa tài liệu này?')) return
    try {
      await apiFetch(`/api/rag/documents/${id}`, { method: 'DELETE' })
      toast.success('Đã xóa tài liệu')
      fetchDocuments()
    } catch (err: any) {
      toast.error('Lỗi khi xóa: ' + err.message)
    }
  }

  async function handleDeleteSession(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('Bạn có muốn xóa cuộc hội thoại này khỏi lịch sử?')) return
    try {
      await apiFetch(`/api/chat/history/sessions/${sessionId}`, { method: 'DELETE' })
      toast.success('Đã xóa cuộc hội thoại')
      if (currentSessionId === sessionId) {
        startNewSession()
      }
      fetchSessions()
    } catch (err: any) {
      toast.error('Không thể xóa: ' + err.message)
    }
  }

  // Hỏi đáp Vector RAG có Stream phản hồi + Lưu lịch sử chat
  async function handleQuery(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return

    setIsSearching(true)
    setSources([])

    // 1. Gửi tin nhắn user vào UI trước
    const userMessage: ChatMessage = { role: 'user', content: query }
    setMessages(prev => [...prev, userMessage])
    setQuery('')

    try {
      // 2. Thực hiện Semantic Search
      const searchRes = await apiFetch<{ context: Source[] }>('/api/rag/query', {
        method: 'POST',
        body: JSON.stringify({ query }),
      })

      const contextChunks = searchRes.context
      setSources(contextChunks)

      if (contextChunks.length === 0) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Không tìm thấy thông tin nào liên quan đến câu hỏi trong tài liệu đã cung cấp.' }])
        setIsSearching(false)
        return
      }

      // 3. Tạo prompt ngữ cảnh
      const contextText = contextChunks.map((c, idx) => `[Tài liệu ${idx + 1}: ${c.filename}]\n${c.content}`).join('\n\n')
      const systemPrompt = `Bạn là Trợ lý Hỏi Đáp dựa vào Tài liệu. Bạn CHỈ ĐƯỢC PHÉP trả lời câu hỏi dựa trên thông tin ngữ cảnh (Context) cung cấp bên dưới. Nếu thông tin không có trong ngữ cảnh, hãy từ chối trả lời lịch sự hoặc nói bạn không tìm thấy thông tin trong tài liệu đã cung cấp. Không tự ý bịa đặt.\n\n[CONTEXT]\n${contextText}`

      // Placeholder cho tin nhắn của assistant
      const assistantPlaceholder: ChatMessage = { role: 'assistant', content: '' }
      setMessages(prev => [...prev, assistantPlaceholder])

      // 4. Gửi streaming chat proxy lên backend
      const token = getToken()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const payload = {
        sessionId: currentSessionId,
        type: 'docs-qa',
        model: 'auto',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.filter(m => m.role !== 'system'),
          userMessage
        ]
      }

      const basePrefix = import.meta.env.BASE_URL.replace(/\/$/, '')
      const response = await fetch(`${basePrefix}/api/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error('Gửi yêu cầu thất bại.')
      }

      const responseSessionId = response.headers.get('x-chat-session-id')
      if (responseSessionId && !currentSessionId) {
        setCurrentSessionId(responseSessionId)
      }

      if (!response.body) {
        throw new Error('Stream body rỗng.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumReply = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6))
              const delta = parsed.choices?.[0]?.delta?.content || ''
              accumReply += delta

              setMessages(prev => {
                const copy = [...prev]
                if (copy.length > 0) {
                  copy[copy.length - 1] = {
                    role: 'assistant',
                    content: accumReply,
                    sourcesJson: JSON.stringify(contextChunks)
                  }
                }
                return copy
              })
            } catch {
              // Ignore sse parsing error
            }
          }
        }
      }

      // Refresh sessions list
      fetchSessions()

    } catch (err: any) {
      toast.error('Lỗi khi truy vấn: ' + err.message)
      setMessages(prev => {
        const copy = [...prev]
        if (copy.length > 0) {
          copy[copy.length - 1] = { role: 'assistant', content: 'Lỗi khi gửi yêu cầu lên mô hình.' }
        }
        return copy
      })
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Hỏi đáp Tài liệu (RAG)" description="Tải tài liệu lên và nhận câu trả lời bảo mật tuyệt đối chỉ dựa vào nội dung tài liệu." divider={true} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* Cột 1: Thêm tài liệu và tài liệu đã học (1/4 screen) */}
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
                  <div key={doc.id} className="flex items-center justify-between p-2 rounded bg-muted/30 border border-muted-foreground/10">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium truncate">{doc.filename}</p>
                      <p className="text-[9px] text-muted-foreground">{new Date(doc.created_at).toLocaleString()}</p>
                    </div>
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="text-[10px] text-red-500 hover:text-red-400 ml-2 shrink-0"
                    >
                      Xóa
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Cột 2: Q&A Chat & Sidebar Lịch sử RAG (3/4 screen) */}
        <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-4 gap-6">
          
          {/* Sidebar Lịch sử Q&A */}
          <div className="md:col-span-1">
            <div className="rounded-3xl border bg-card p-4 space-y-3 min-h-[450px] flex flex-col">
              <div className="flex justify-between items-center pb-2 border-b">
                <h3 className="text-xs font-semibold text-cyan-400">Lịch sử Q&A</h3>
                <button
                  onClick={startNewSession}
                  className="text-[10px] bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-400 px-2 py-0.5 rounded"
                >
                  Mới +
                </button>
              </div>

              {sessions.length === 0 ? (
                <p className="text-[10px] text-muted-foreground text-center my-auto">Chưa có lịch sử Q&A.</p>
              ) : (
                <div className="flex-1 space-y-2 overflow-y-auto max-h-[380px]">
                  {sessions.map((sess) => (
                    <div
                      key={sess.id}
                      onClick={() => loadSession(sess.id)}
                      className={`p-2 rounded-xl border text-[11px] cursor-pointer flex justify-between items-center transition ${
                        currentSessionId === sess.id
                          ? 'border-cyan-500 bg-cyan-500/5 text-cyan-400 font-medium'
                          : 'border-muted-foreground/10 hover:bg-muted/40'
                      }`}
                    >
                      <span className="truncate pr-1">{sess.title}</span>
                      <button
                        onClick={(e) => handleDeleteSession(sess.id, e)}
                        className="text-red-500 hover:text-red-400 text-[10px] shrink-0"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Khung Q&A Chat */}
          <div className="md:col-span-3 space-y-6">
            <section className="rounded-3xl border bg-card p-5 space-y-4 min-h-[450px] flex flex-col justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Khung Q&A Thông minh</h2>

              {/* Chat Container */}
              <div className="flex-1 space-y-3 my-3 overflow-y-auto max-h-96 p-2 rounded-xl bg-muted/15">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 text-muted-foreground space-y-2">
                    <p className="text-xs">Chưa có câu hỏi nào được thực hiện.</p>
                    <p className="text-[10px]">Tải lên tài liệu bên trái và bắt đầu hỏi đáp ngữ cảnh.</p>
                  </div>
                ) : (
                  <>
                    {messages.map((m, idx) => (
                      <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-2 text-xs leading-relaxed ${
                            m.role === 'user'
                              ? 'bg-cyan-600 text-white rounded-tr-none'
                              : 'bg-muted/50 text-foreground border border-cyan-500/5 rounded-tl-none whitespace-pre-wrap'
                          }`}
                        >
                          {m.content}
                        </div>
                      </div>
                    ))}
                    {isSearching && messages[messages.length - 1]?.content === '' && (
                      <div className="flex justify-start">
                        <div className="rounded-2xl px-4 py-2 text-xs bg-muted/50 text-muted-foreground animate-pulse rounded-tl-none">
                          AI đang lục tìm tài liệu...
                        </div>
                      </div>
                    )}
                  </>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Citations / Trích nguồn */}
              {sources.length > 0 && (
                <div className="space-y-1.5 border-t pt-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">Nguồn tham khảo gần nhất:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                    {sources.map((s, idx) => (
                      <div key={idx} className="p-2.5 rounded-lg border bg-card/60 text-[10px]">
                        <p className="font-semibold text-cyan-400 truncate mb-1">
                          Tài liệu: {s.filename} ({Math.round(s.similarity * 100)}% khớp)
                        </p>
                        <p className="text-muted-foreground line-clamp-3 leading-normal">{s.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Form gửi câu hỏi */}
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
                  {isSearching && messages.length === 0 ? 'Đang lục tài liệu...' : 'Hỏi AI'}
                </button>
              </form>
            </section>
          </div>

        </div>

      </div>
    </div>
  )
}
