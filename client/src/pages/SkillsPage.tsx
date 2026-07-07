import { useState, useEffect } from 'react'
import { PageHeader } from '@/components/page-header'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { CardSkeleton } from '@/components/ui/skeleton'

interface Skill {
  id: number
  name: string
  description: string
  system_prompt: string
  created_at: string
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
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([])
  const [isSending, setIsSending] = useState(false)

  useEffect(() => {
    fetchSkills()
  }, [])

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

  async function handleDelete(id: number) {
    if (!confirm('Bạn chắc chắn muốn xóa trợ lý này?')) return
    try {
      await apiFetch(`/api/skills/${id}`, { method: 'DELETE' })
      toast.success('Đã xóa trợ lý')
      if (activeSkill?.id === id) {
        setActiveSkill(null)
        setMessages([])
      }
      fetchSkills()
    } catch (err: any) {
      toast.error('Lỗi khi xóa: ' + err.message)
    }
  }

  async function startChat(skill: Skill) {
    setActiveSkill(skill)
    setMessages([
      { role: 'assistant', content: `Xin chào! Tôi đã được nạp Kỹ năng: **${skill.name}**.\nHãy đặt câu hỏi cho tôi về chủ đề này.` }
    ])
    setChatInput('')
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!chatInput.trim() || !activeSkill) return

    const userMessage = { role: 'user', content: chatInput }
    setMessages(prev => [...prev, userMessage])
    setChatInput('')
    setIsSending(true)

    try {
      const chatRes = await apiFetch<{ choices: { message: { content: string } }[] }>('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'auto',
          messages: [
            { role: 'system', content: activeSkill.system_prompt },
            ...messages.filter(m => m.role !== 'system'),
            userMessage
          ]
        })
      })

      const reply = chatRes.choices?.[0]?.message?.content || 'Không nhận được câu trả lời từ mô hình.'
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (err: any) {
      toast.error('Lỗi kết nối mô hình: ' + err.message)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Skills / Trợ lý Chuyên gia" description="Tạo các trợ lý ảo chuyên gia lập trình được định hướng bằng System Prompt tối ưu." divider={true} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Kho chuyên gia và thêm mới */}
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

        {/* Khung chat chuyên gia */}
        <div className="lg:col-span-2 space-y-6">
          <section className="rounded-3xl border bg-card p-5 space-y-4 min-h-[450px] flex flex-col justify-between">
            {activeSkill ? (
              <>
                <div className="flex items-center justify-between border-b pb-2">
                  <div>
                    <h2 className="text-sm font-bold text-cyan-400">{activeSkill.name}</h2>
                    <p className="text-[10px] text-muted-foreground">{activeSkill.description}</p>
                  </div>
                </div>

                {/* Danh sách tin nhắn */}
                <div className="flex-1 space-y-3 my-3 overflow-y-auto max-h-96 p-2 rounded-xl bg-muted/15">
                  {messages.map((m, idx) => (
                    <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-2 text-xs leading-relaxed ${
                          m.role === 'user'
                            ? 'bg-cyan-600 text-white rounded-tr-none'
                            : 'bg-muted/50 text-foreground border border-cyan-500/5 rounded-tl-none'
                        }`}
                      >
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {isSending && (
                    <div className="flex justify-start">
                      <div className="rounded-2xl px-4 py-2 text-xs bg-muted/50 text-muted-foreground animate-pulse rounded-tl-none">
                        Chuyên gia đang suy nghĩ...
                      </div>
                    </div>
                  )}
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
  )
}
