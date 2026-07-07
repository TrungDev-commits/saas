import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const skillsRouter = Router();

// 1. API: Lấy tất cả skills
skillsRouter.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const skills = db.prepare('SELECT id, name, description, system_prompt, created_at FROM skills ORDER BY id ASC').all();
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
skillsRouter.post('/', (req: Request, res: Response) => {
  const parsed = skillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { name, description, systemPrompt } = parsed.data;
  const db = getDb();

  try {
    const result = db.prepare('INSERT INTO skills (name, description, system_prompt) VALUES (?, ?, ?)')
      .run(name, description || null, systemPrompt);
    res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: { message: 'Tên kỹ năng chuyên gia này đã tồn tại.' } });
    } else {
      res.status(500).json({ error: { message: err.message } });
    }
  }
});

// 3. API: Xóa skill
skillsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
