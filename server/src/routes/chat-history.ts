import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPrisma } from '../lib/prisma.js';
import { z } from 'zod';

export const chatHistoryRouter = Router();

// 1. API: Lấy 20 sessions gần nhất (không phân quyền theo user)
chatHistoryRouter.get('/sessions', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const type = req.query.type as string; // lọc theo playground, expert, docs-qa
    const skillId = req.query.skillId as string;

    const sessions = await prisma.chatSession.findMany({
      where: {
        type: type || undefined,
        skillId: skillId || undefined
      },
      orderBy: { updatedAt: 'desc' },
      take: 20
    });
    res.json({ success: true, sessions });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 2. API: Lấy chi tiết session kèm tin nhắn
chatHistoryRouter.get('/sessions/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const prisma = getPrisma();
    const session = await prisma.chatSession.findUnique({
      where: { id: id as string },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!session) {
      res.status(404).json({ error: { message: 'Không tìm thấy cuộc hội thoại.' } });
      return;
    }

    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 3. API: Tạo session trống
chatHistoryRouter.post('/sessions', async (req: Request, res: Response) => {
  const { title, type, skillId, documentIds, model } = req.body;
  try {
    const prisma = getPrisma();
    const session = await prisma.chatSession.create({
      data: {
        title: title || 'Cuộc hội thoại mới',
        type: type || 'playground',
        skillId: skillId || null,
        documentIds: documentIds || [],
        model: model || 'auto'
      }
    });
    res.status(201).json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 4. API: Cập nhật tiêu đề session
chatHistoryRouter.put('/sessions/:id/title', async (req: Request, res: Response) => {
  const id = req.params.id;
  const { title } = req.body;
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: { message: 'Tiêu đề không hợp lệ.' } });
    return;
  }

  try {
    const prisma = getPrisma();
    const session = await prisma.chatSession.update({
      where: { id: id as string },
      data: { title }
    });
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 5. API: Xóa session
chatHistoryRouter.delete('/sessions/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const prisma = getPrisma();
    await prisma.chatSession.delete({
      where: { id: id as string }
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
