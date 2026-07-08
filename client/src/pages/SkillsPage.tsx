import { useState, useEffect, useRef } from 'react'
import { PageHeader } from '@/components/page-header'
import { apiFetch, getToken } from '@/lib/api'
import { toast } from '@/lib/toast'
import { CardSkeleton } from '@/components/ui/skeleton'

interface Skill {
  id: string
  name: string
  description: string
  system_prompt: string
  created_at: string
}

interface ChatSession {
  id: string
  title: string
  type: string
  skillId?: string
  model?: string
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id?: string
  role: string
  content: string
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Form states
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Active chat state
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isSending, setIsSending] = useState(false)

  // Tri thức tự học states
  const [facts, setFacts] = useState<string[]>([])
  const [isLearning, setIsLearning] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchSkills()
  }, [])

  useEffect(() => {
    if (activeSkill) {
      fetchSessions(activeSkill.id)
      fetchKnowledge(activeSkill.id)
    }
  }, [activeSkill])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isSending])

  async function fetchSkills() {
    try {
      const res = await apiFetch<{ skills: Skill[] }>('/api/skills')
      setSkills(res.skills || [])
    } catch (err: any) {
      toast.error('Lỗi khi lấy danh sách kỹ năng: ' + err.message)
    } finally {
      setIsLoading(false)
    }
  }

  async function fetchSessions(skillId: string) {
    try {
      const res = await apiFetch<{ sessions: ChatSession[] }>(`/api/chat/history/sessions?type=expert&skillId=${skillId}`)
      setSessions(res.sessions || [])
    } catch (err: any) {
      console.error('Không thể lấy lịch sử chat:', err)
    }
  }

  async function fetchKnowledge(skillId: string) {
    try {
      const res = await apiFetch<{ facts: string[] }>(`/api/skills/${skillId}/knowledge`)
      setFacts(res.facts || [])
    } catch (err) {
      console.error('Không thể tải tri thức đã học:', err)
    }
  }

  async function handleResetKnowledge() {
    if (!activeSkill) return
    if (!confirm('Bạn có chắc chắn muốn xóa toàn bộ tri thức tự học của trợ lý này? AI sẽ bị mất trí nhớ.')) return
    
    try {
      await apiFetch(`/api/skills/${activeSkill.id}/knowledge`, { method: 'DELETE' })
      toast.success('Đã xóa sạch tri thức tự học!')
      fetchKnowledge(activeSkill.id)
    } catch (err: any) {
      toast.error('Lỗi khi xóa tri thức: ' + err.message)
    }
  }

  async function loadSession(sessionId: string) {
    setIsSending(true)
    try {
      const res = await apiFetch<{ session: ChatSession & { messages: ChatMessage[] } }>(`/api/chat/history/sessions/${sessionId}`)
      if (res.session) {
        setCurrentSessionId(res.session.id)
        setMessages(res.session.messages)
      }
    } catch (err: any) {
      toast.error('Không thể tải lịch sử chat: ' + err.message)
    } finally {
      setIsSending(false)
    }
  }

  async function startNewSession() {
    if (!activeSkill) return
    setCurrentSessionId(null)
    setMessages([
      { role: 'assistant', content: `Xin chào! Tôi đã được nạp Kỹ năng: **${activeSkill.name}**.\nHãy đặt câu hỏi cho tôi về chủ đề này.` }
    ])
    setChatInput('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !systemPrompt.trim()) return

    setIsSaving(true)
    try {
      await apiFetch('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name, description, systemPrompt }),
      })
      toast.success('Thêm Trợ lý Chuyên gia thành công!')
      setName('')
      setDescription('')
      setSystemPrompt('')
      fetchSkills()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Bạn chắc chắn muốn xóa trợ lý này?')) return
    try {
      await apiFetch(`/api/skills/${id}`, { method: 'DELETE' })
      toast.success('Đã xóa trợ lý')
      if (activeSkill?.id === id) {
        setActiveSkill(null)
        setMessages([])
        setCurrentSessionId(null)
        setSessions([])
        setFacts([])
      }
      fetchSkills()
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
      if (activeSkill) {
        fetchSessions(activeSkill.id)
      }
    } catch (err: any) {
      toast.error('Không thể xóa: ' + err.message)
    }
  }

  async function startChat(skill: Skill) {
    setActiveSkill(skill)
    setCurrentSessionId(null)
    setMessages([
      { role: 'assistant', content: `Xin chào! Tôi đã được nạp Kỹ năng: **${skill.name}**.\nHãy đặt câu hỏi cho tôi về chủ đề này.` }
    ])
    setChatInput('')
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!chatInput.trim() || !activeSkill) return

    const userMessage: ChatMessage = { role: 'user', content: chatInput }
    setMessages(prev => [...prev, userMessage])
    setChatInput('')
    setIsSending(true)

    const assistantPlaceholder: ChatMessage = { role: 'assistant', content: '' }
    setMessages(prev => [...prev, assistantPlaceholder])

    try {
      const token = getToken()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const payload = {
        sessionId: currentSessionId,
        type: 'expert',
        skillId: activeSkill.id,
        model: 'auto',
        stream: true,
        messages: [
          { role: 'system', content: activeSkill.system_prompt },
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
        throw new Error('Response stream body rỗng.')
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
                  copy[copy.length - 1] = { role: 'assistant', content: accumReply }
                }
                return copy
              })
            } catch {
              // Ignore
            }
          }
        }
      }

      // Kích hoạt animation tự học nhỏ
      setIsLearning(true)
      setTimeout(() => {
        setIsLearning(false)
        fetchKnowledge(activeSkill.id)
      }, 3000)

      fetchSessions(activeSkill.id)

    } catch (err: any) {
      toast.error('Lỗi khi chat: ' + err.message)
      setMessages(prev => {
        const copy = [...prev]
        if (copy.length > 0) {
          copy[copy.length - 1] = { role: 'assistant', content: 'Lỗi khi gửi yêu cầu lên mô hình.' }
        }
        return copy
      })
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Skills / Trợ lý Chuyên gia" description="Tạo các trợ lý ảo chuyên gia lập trình được định hướng bằng System Prompt tối ưu." divider={true} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Cột 1: Cấu hình trợ lý và Thư viện (1/4 screen) */}
        <div className="space-y-6 lg:col-span-1">
          <section className="rounded-3xl border bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Tạo Chuyên gia Mới</h2>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Tên Chuyên gia</label>
                <input
                  type="text"
                  placeholder="Ví dụ: Chuyên gia GIS OpenLayers"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  required
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Mô tả ngắn</label>
                <input
                  type="text"
                  placeholder="Hỗ trợ code conventions và GIS Module..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">System Prompt (Chỉ dẫn hành vi)</label>
                <textarea
                  placeholder="Bạn là lập trình viên cấp cao chuyên nghiệp..."
                  rows={4}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={isSaving}
                className="w-full rounded-full bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
              >
                {isSaving ? 'Đang lưu...' : 'Thêm Chuyên gia'}
              </button>
            </form>
          </section>

          <section className="rounded-3xl border bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold tracking-wide text-cyan-400">Thư viện Trợ lý</h2>
            {isLoading ? (
              <CardSkeleton />
            ) : skills.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có trợ lý chuyên gia nào được cấu hình.</p>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    onClick={() => startChat(skill)}
                    className={`p-3 rounded-2xl border cursor-pointer transition ${
                      activeSkill?.id === skill.id
                        ? 'border-cyan-500 bg-cyan-500/5'
                        : 'border-muted-foreground/10 bg-muted/20 hover:bg-muted/40'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <p className="text-xs font-bold">{skill.name}</p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(skill.id)
                        }}
                        className="text-[10px] text-red-500 hover:text-red-400"
                      >
                        Xóa
                      </button>
                    </div>
                    {skill.description && (
                      <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{skill.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Khung chat chuyên gia & Lịch sử chat & Tri thức tự học (3/4 screen) */}
        <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-4 gap-6">
          
          {/* Lịch sử chat của chuyên gia */}
          <div className="md:col-span-1 space-y-4">
            <div className="rounded-3xl border bg-card p-4 space-y-3 min-h-[220px] flex flex-col">
              <div className="flex justify-between items-center pb-2 border-b">
                <h3 className="text-xs font-semibold text-cyan-400">Lịch sử chat</h3>
                {activeSkill && (
                  <button
                    onClick={startNewSession}
                    className="text-[10px] bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-400 px-2 py-0.5 rounded"
                  >
                    Mới +
                  </button>
                )}
              </div>
              
              {!activeSkill ? (
                <p className="text-[10px] text-muted-foreground text-center my-auto">Chọn chuyên gia để xem lịch sử.</p>
              ) : sessions.length === 0 ? (
                <p className="text-[10px] text-muted-foreground text-center my-auto">Chưa có lịch sử hội thoại.</p>
              ) : (
                <div className="flex-1 space-y-2 overflow-y-auto max-h-[160px]">
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

            {/* Tri thức AI tự học (Tôi Tương Lai) */}
            <div className="rounded-3xl border bg-card p-4 space-y-3 min-h-[220px] flex flex-col">
              <div className="flex justify-between items-center pb-2 border-b">
                <h3 className="text-xs font-semibold text-cyan-400">Trí tuệ tự học</h3>
                {facts.length > 0 && (
                  <button
                    onClick={handleResetKnowledge}
                    className="text-[9px] text-red-400 hover:text-red-300"
                  >
                    Xóa hết
                  </button>
                )}
              </div>

              {isLearning ? (
                <div className="flex flex-col items-center justify-center text-center my-auto animate-pulse space-y-2">
                  <div className="w-5 h-5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin"></div>
                  <p className="text-[10px] text-cyan-400">AI đang tự đúc kết tri thức mới...</p>
                </div>
              ) : !activeSkill ? (
                <p className="text-[10px] text-muted-foreground text-center my-auto">Chọn chuyên gia.</p>
              ) : facts.length === 0 ? (
                <p className="text-[10px] text-muted-foreground text-center my-auto">AI chưa tự học được gì. Trò chuyện thêm để AI tích lũy facts.</p>
              ) : (
                <div className="flex-1 space-y-1.5 overflow-y-auto max-h-[160px]">
                  {facts.map((fact, idx) => (
                    <div key={idx} className="p-2 rounded-xl bg-cyan-600/5 border border-cyan-500/10 text-[10px] leading-relaxed text-cyan-300">
                      💡 {fact}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Khung chat tin nhắn (3/4 cột chat) */}
          <div className="md:col-span-3">
            <section className="rounded-3xl border bg-card p-5 space-y-4 min-h-[460px] flex flex-col justify-between">
              {activeSkill ? (
                <>
                  <div className="flex items-center justify-between border-b pb-2">
                    <div>
                      <h2 className="text-sm font-bold text-cyan-400">{activeSkill.name}</h2>
                      <p className="text-[10px] text-muted-foreground">{activeSkill.description}</p>
                    </div>
                  </div>

                  {/* Danh sách tin nhắn */}
                  <div className="flex-1 space-y-3 my-3 overflow-y-auto max-h-80 p-2 rounded-xl bg-muted/15">
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
                    {isSending && messages[messages.length - 1]?.content === '' && (
                      <div className="flex justify-start">
                        <div className="rounded-2xl px-4 py-2 text-xs bg-muted/50 text-muted-foreground animate-pulse rounded-tl-none">
                          Chuyên gia đang suy nghĩ...
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  <form onSubmit={handleSend} className="flex gap-2">
                    <input
                      type="text"
                      placeholder={`Hỏi chuyên gia về ${activeSkill.name}...`}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      className="flex-1 rounded-full border bg-transparent px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      required
                    />
                    <button
                      type="submit"
                      disabled={isSending}
                      className="rounded-full bg-cyan-600 px-6 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
                    >
                      Gửi
                    </button>
                  </form>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-muted-foreground space-y-2">
                  <p className="text-xs">Chưa có Trợ lý nào được chọn.</p>
                  <p className="text-[10px]">Vui lòng chọn một Trợ lý Chuyên gia bên trái hoặc tự cấu hình mới để bắt đầu chat.</p>
                </div>
              )}
            </section>
          </div>

        </div>

      </div>
    </div>
  )
}
