import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { runEmbeddings } from '../services/embeddings.js';

export const ragRouter = Router();

// Hàm tính khoảng cách Cosine Similarity giữa 2 vector
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

// 1. API: Lấy danh sách tài liệu
ragRouter.get('/documents', (req: Request, res: Response) => {
  try {
    const docs = getDb().prepare('SELECT id, filename, created_at FROM documents ORDER BY id DESC').all();
    res.json({ success: true, documents: docs });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Schema validation cho tải lên văn bản đơn giản
const uploadTextSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(10),
});

// 2. API: Upload tài liệu (Hỗ trợ upload dạng text thuần trước, có thể nâng cấp parser sau)
ragRouter.post('/upload', async (req: Request, res: Response) => {
  const parsed = uploadTextSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { filename, content } = parsed.data;
  const db = getDb();

  try {
    // 1. Chia nhỏ văn bản (Chunking) - khoảng 500 ký tự mỗi chunk, overlap 100 ký tự
    const chunkSize = 500;
    const overlap = 100;
    const chunks: string[] = [];
    let i = 0;
    while (i < content.length) {
      chunks.push(content.substring(i, i + chunkSize));
      i += chunkSize - overlap;
    }

    // 2. Thêm tài liệu vào bảng documents
    const docResult = db.prepare('INSERT INTO documents (filename) VALUES (?)').run(filename);
    const documentId = Number(docResult.lastInsertRowid);

    // 3. Tạo Embeddings cho từng chunk và lưu vào db
    for (const chunkText of chunks) {
      // Gọi service tính embedding mặc định của hệ thống
      const embResult = await runEmbeddings(undefined, [chunkText]);
      const embeddingVector = embResult.vectors[0];

      db.prepare('INSERT INTO document_chunks (document_id, content, embedding) VALUES (?, ?, ?)')
        .run(documentId, chunkText, JSON.stringify(embeddingVector));
    }

    res.status(201).json({ success: true, documentId, chunksCount: chunks.length });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 3. API: Xóa tài liệu
ragRouter.delete('/documents/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Schema validation cho truy vấn RAG
const querySchema = z.object({
  query: z.string().min(1),
  documentIds: z.array(z.number()).optional(), // Nếu truyền thì chỉ tìm trong các file này, không truyền thì tìm tất cả
});

// 4. API: Truy vấn tìm kiếm các chunks tương đồng nhất (Semantic Search)
ragRouter.post('/query', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { query, documentIds } = parsed.data;
  const db = getDb();

  try {
    // 1. Tính embedding của câu hỏi
    const queryEmbResult = await runEmbeddings(undefined, [query]);
    const queryVector = queryEmbResult.vectors[0];

    // 2. Lấy toàn bộ chunks từ db
    let chunksRows: { id: number; content: string; embedding: string; filename: string }[] = [];
    if (documentIds && documentIds.length > 0) {
      const placeholders = documentIds.map(() => '?').join(',');
      chunksRows = db.prepare(`
        SELECT c.id, c.content, c.embedding, d.filename
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.document_id IN (${placeholders})
      `).all(...documentIds) as any;
    } else {
      chunksRows = db.prepare(`
        SELECT c.id, c.content, c.embedding, d.filename
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
      `).all() as any;
    }

    // 3. Tính độ tương đồng cosine và sắp xếp
    const matchedChunks = chunksRows.map(row => {
      const vector = JSON.parse(row.embedding) as number[];
      const similarity = cosineSimilarity(queryVector, vector);
      return {
        content: row.content,
        filename: row.filename,
        similarity,
      };
    })
    .filter(item => item.similarity > 0.3) // Ngưỡng tương đồng tối thiểu
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 4); // Lấy top 4 chunks liên quan nhất

    res.json({ success: true, context: matchedChunks });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
