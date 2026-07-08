import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey } from '../db/index.js';
import { getPrisma } from '../lib/prisma.js';
import { runEmbeddings } from '../services/embeddings.js';

export const chatProxyRouter = Router();

// Helper: tính cosine similarity
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Helper: Tìm kiếm tri thức đã học (RAG) cho một Chuyên gia ảo
async function retrieveLearnedKnowledge(skillId: string, userQuery: string): Promise<string[]> {
  try {
    const prisma = getPrisma();
    
    // Tìm document lưu tri thức tự học của Skill này
    const doc = await prisma.document.findFirst({
      where: { filename: `__skill_knowledge_${skillId}` }
    });
    if (!doc) return [];

    // Tìm kiếm các vector embeddings
    const queryEmbResult = await runEmbeddings(undefined, [userQuery]);
    const queryVector = queryEmbResult.vectors[0];

    const chunks = await prisma.documentChunk.findMany({
      where: { documentId: doc.id }
    });

    const matches = chunks.map((c: { embedding: number[]; content: string }) => {
      const similarity = cosineSimilarity(queryVector, c.embedding);
      return { content: c.content, similarity };
    })
    .filter((item: { similarity: number }) => item.similarity > 0.35) // Ngưỡng tương đồng
    .sort((a: { similarity: number }, b: { similarity: number }) => b.similarity - a.similarity)
    .slice(0, 3); // Lấy top 3 facts liên quan nhất

    return matches.map((m: { content: string }) => m.content);
  } catch (err) {
    console.error('Lỗi khi truy xuất tri thức tự học:', err);
    return [];
  }
}

// Trigger ngầm gọi API tự học của Skill
async function triggerSelfLearning(skillId: string, messages: any[]): Promise<void> {
  try {
    // Chỉ kích hoạt tự học nếu cuộc hội thoại có từ 2 cặp hội thoại trở lên
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length < 2) return;

    // Gộp hội thoại thành văn bản thô để LLM phân tích
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
      .join('\n');

    const port = process.env.PORT || '4000';
    const learnUrl = `http://localhost:${port}/api/skills/${skillId}/learn`;

    // Gọi trigger ngầm
    await fetch(learnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ conversationText })
    });
  } catch (err) {
    console.error('Trigger tự học thất bại:', err);
  }
}

// Endpoint phụ giúp Frontend lưu trữ tin nhắn, đồng thời forward sang proxy API (/v1/chat/completions)
chatProxyRouter.post('/completions', async (req: Request, res: Response): Promise<void> => {
  try {
    const unifiedKey = getUnifiedApiKey();
    if (!unifiedKey) {
      res.status(503).json({ error: { message: 'Chưa khởi tạo Unified API Key trong hệ thống.' } });
      return;
    }

    const { sessionId, type, skillId, documentIds, model, messages, stream } = req.body;
    
    // Yêu cầu tối thiểu phải có tin nhắn
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: { message: 'messages là trường bắt buộc.' } });
      return;
    }

    const userMessage = messages[messages.length - 1];
    const prisma = getPrisma();
    let currentSessionId = sessionId;

    // 1. Tạo session tự động nếu chưa truyền sessionId
    if (!currentSessionId) {
      const firstMessageText = userMessage?.content || 'Cuộc hội thoại mới';
      const title = firstMessageText.length > 30 ? firstMessageText.slice(0, 30) + '...' : firstMessageText;
      const session = await prisma.chatSession.create({
        data: {
          title,
          type: type || 'playground',
          skillId: skillId || null,
          documentIds: documentIds || [],
          model: model || 'auto'
        }
      });
      currentSessionId = session.id;
    }

    // 2. Lưu tin nhắn User vào database
    await prisma.chatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: userMessage.role || 'user',
        content: userMessage.content || ''
      }
    });

    // 3. Nếu là Expert chat (có skillId), tiến hành RAG search tri thức tự học của AI
    const apiMessages = [...messages];
    if (type === 'expert' && skillId) {
      const facts = await retrieveLearnedKnowledge(skillId, userMessage.content);
      if (facts.length > 0) {
        // Inject tri thức đã học vào tin nhắn system prompt đầu tiên
        const systemMsgIndex = apiMessages.findIndex(m => m.role === 'system');
        const factsText = `\n\n[TRI THỨC BẠN ĐÃ TỰ HỌC ĐƯỢC VỀ NGƯỜI DÙNG TỪ CÁC CUỘC HỘI THOẠI TRƯỚC]:\n${facts.map(f => `- ${f}`).join('\n')}`;
        
        if (systemMsgIndex !== -1) {
          apiMessages[systemMsgIndex] = {
            ...apiMessages[systemMsgIndex],
            content: apiMessages[systemMsgIndex].content + factsText
          };
        } else {
          apiMessages.unshift({
            role: 'system',
            content: `Bạn là trợ lý ảo chuyên nghiệp.` + factsText
          });
        }
      }
    }

    // 4. Thiết lập kết nối gọi API proxy đích
    const port = process.env.PORT || '4000';
    const targetUrl = `http://localhost:${port}/v1/chat/completions`;

    const forwardBody = {
      model: model || 'auto',
      messages: apiMessages,
      stream: stream === true
    };

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${unifiedKey}`,
      },
      body: JSON.stringify(forwardBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.status(response.status).send(errorText);
      return;
    }

    // Thiết lập Header phản hồi tương ứng
    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }
    res.setHeader('x-chat-session-id', currentSessionId);
    res.status(response.status);

    let assistantReply = '';

    if (stream === true && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        res.write(value);

        const chunkText = decoder.decode(value, { stream: true });
        const lines = chunkText.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content || '';
              assistantReply += delta;
            } catch {
              // Ignore
            }
          }
        }
      }
      res.end();
    } else {
      const dataText = await response.text();
      res.send(dataText);

      try {
        const parsed = JSON.parse(dataText);
        assistantReply = parsed.choices?.[0]?.message?.content || '';
      } catch {
        assistantReply = dataText;
      }
    }

    // 5. Lưu tin nhắn của Assistant trả về vào MongoDB
    if (assistantReply) {
      await prisma.chatMessage.create({
        data: {
          sessionId: currentSessionId,
          role: 'assistant',
          content: assistantReply
        }
      });
      await prisma.chatSession.update({
        where: { id: currentSessionId },
        data: { updatedAt: new Date() }
      });

      // 6. Trigger ngầm quá trình tự học (self learning) nếu là Expert chat
      if (type === 'expert' && skillId) {
        // Lấy lịch sử chat đầy đủ của session để LLM phân tích trích xuất facts mới
        const fullMessages = await prisma.chatMessage.findMany({
          where: { sessionId: currentSessionId },
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true }
        });
        
        // Chạy trigger ngầm trong background, không block response chat của người dùng
        triggerSelfLearning(skillId, fullMessages);
      }
    }

  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
