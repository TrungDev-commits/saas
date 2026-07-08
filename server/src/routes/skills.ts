import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '../lib/prisma.js';
import { runEmbeddings } from '../services/embeddings.js';
import { getUnifiedApiKey } from '../db/index.js';

export const skillsRouter = Router();

// Helper: Gọi LLM nội bộ trích xuất facts từ hội thoại
async function extractFactsFromConversation(conversationText: string): Promise<string[]> {
  try {
    const unifiedKey = getUnifiedApiKey();
    if (!unifiedKey) return [];

    const port = process.env.PORT || '4000';
    const targetUrl = `http://localhost:${port}/v1/chat/completions`;

    const systemPrompt = `Bạn là hệ thống AI phân tích hội thoại. Nhiệm vụ của bạn là đọc nội dung cuộc trò chuyện bên dưới và trích xuất ra các mẩu kiến thức (facts), thói quen, thông tin cá nhân của người dùng, hoặc các quy tắc lập trình mới được thống nhất trong cuộc chat.
Yêu cầu:
1. Mỗi mẩu kiến thức viết ngắn gọn, súc tích dưới dạng 1 câu ngắn.
2. Trả về định dạng JSON thuần chứa mảng các chuỗi, ví dụ: ["Người dùng tên Trung", "Người dùng đang viết code Laravel", "Thống nhất viết Vue 2 theo Options API"].
3. CHỈ TRẢ VỀ JSON, không thêm bất kỳ văn bản giải thích nào khác ngoài JSON.`;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${unifiedKey}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: conversationText }
        ]
      })
    });

    if (!response.ok) return [];
    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';

    // Regex trích xuất JSON array đề phòng LLM trả thêm markdown code blocks
    const jsonMatch = content.match(/\[\s*".*"\s*\]/s) || content.match(/\[.*\]/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as string[];
    }
    return JSON.parse(content) as string[];
  } catch (err) {
    console.error('Lỗi khi LLM trích xuất tri thức tự học:', err);
    return [];
  }
}

// 1. API: Lấy tất cả skills từ MongoDB
skillsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const skills = await prisma.skill.findMany({
      orderBy: { createdAt: 'asc' }
    });
    res.json({ success: true, skills });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

const skillSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  systemPrompt: z.string().min(10),
});

// 2. API: Tạo mới skill
skillsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = skillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { name, description, systemPrompt } = parsed.data;
  const prisma = getPrisma();

  try {
    const result = await prisma.skill.create({
      data: {
        name,
        description: description || null,
        systemPrompt,
      }
    });
    res.status(201).json({ success: true, id: result.id });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { message: 'Tên kỹ năng chuyên gia này đã tồn tại.' } });
    } else {
      res.status(500).json({ error: { message: err.message } });
    }
  }
});

// 3. API: Xóa skill khỏi MongoDB
skillsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    await getPrisma().skill.delete({
      where: { id: id as string }
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 4. API: AI tự học từ cuộc hội thoại (Trích xuất tri thức và lưu RAG)
skillsRouter.post('/:id/learn', async (req: Request, res: Response) => {
  const skillId = req.params.id as string;
  const { conversationText } = req.body;

  if (!conversationText || typeof conversationText !== 'string') {
    res.status(400).json({ error: { message: 'conversationText là bắt buộc.' } });
    return;
  }

  try {
    const prisma = getPrisma();
    
    // 1. Trích xuất facts từ cuộc hội thoại dùng LLM
    const facts = await extractFactsFromConversation(conversationText);
    if (facts.length === 0) {
      res.json({ success: true, learnedCount: 0, message: 'Không phát hiện kiến thức mới cần ghi nhớ.' });
      return;
    }

    // 2. Lấy hoặc tạo bản ghi SkillKnowledge
    let knowledge = await prisma.skillKnowledge.findUnique({
      where: { skillId }
    });

    if (!knowledge) {
      knowledge = await prisma.skillKnowledge.create({
        data: {
          skillId,
          facts: []
        }
      });
    }

    // Lọc trùng lặp facts đã học trước đó
    const newFacts = facts.filter(f => !knowledge!.facts.includes(f));
    if (newFacts.length === 0) {
      res.json({ success: true, learnedCount: 0, message: 'Kiến thức này AI đã được học từ trước.' });
      return;
    }

    // 3. Cập nhật facts vào SkillKnowledge
    const updatedFacts = [...knowledge.facts, ...newFacts];
    await prisma.skillKnowledge.update({
      where: { skillId },
      data: { facts: updatedFacts }
    });

    // 4. Vector hóa từng fact và lưu vào DocumentChunk (RAG Vector Store) để phục vụ tìm kiếm ngữ cảnh
    // Tạo 1 document giả định đại diện cho tri thức tự học của Skill này
    let doc = await prisma.document.findFirst({
      where: { filename: `__skill_knowledge_${skillId}` }
    });

    if (!doc) {
      doc = await prisma.document.create({
        data: {
          filename: `__skill_knowledge_${skillId}`,
          filePath: `skill_kb_${skillId}`
        }
      });
    }

    const chunksToCreate = [];
    for (const factText of newFacts) {
      const embResult = await runEmbeddings(undefined, [factText]);
      const embeddingVector = embResult.vectors[0];
      chunksToCreate.push({
        documentId: doc.id,
        content: factText,
        embedding: embeddingVector
      });
    }

    await prisma.documentChunk.createMany({
      data: chunksToCreate
    });

    res.json({ success: true, learnedCount: newFacts.length, newFacts });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 5. API: Lấy toàn bộ facts đã học của một Skill
skillsRouter.get('/:id/knowledge', async (req: Request, res: Response) => {
  const skillId = req.params.id as string;
  try {
    const prisma = getPrisma();
    const knowledge = await prisma.skillKnowledge.findUnique({
      where: { skillId }
    });
    res.json({ success: true, facts: knowledge?.facts || [] });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 6. API: Xóa toàn bộ tri thức của một Skill
skillsRouter.delete('/:id/knowledge', async (req: Request, res: Response) => {
  const skillId = req.params.id as string;
  try {
    const prisma = getPrisma();
    await prisma.skillKnowledge.delete({
      where: { skillId }
    });
    
    // Xóa document vector của skill đó
    const doc = await prisma.document.findFirst({
      where: { filename: `__skill_knowledge_${skillId}` }
    });
    if (doc) {
      await prisma.document.delete({
        where: { id: doc.id }
      });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
