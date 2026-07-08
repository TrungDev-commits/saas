import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '../lib/prisma.js';
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

// 1. API: Lấy danh sách tài liệu từ MongoDB
ragRouter.get('/documents', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const docs = await prisma.document.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, createdAt: true }
    });
    res.json({ success: true, documents: docs });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

const uploadTextSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(10),
});

// 2. API: Upload tài liệu vào MongoDB
ragRouter.post('/upload', async (req: Request, res: Response) => {
  const parsed = uploadTextSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { filename, content } = parsed.data;
  const prisma = getPrisma();

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

    // 2. Thêm tài liệu vào bảng documents trên MongoDB
    const doc = await prisma.document.create({
      data: { filename }
    });
    const documentId = doc.id;

    // 3. Tạo Embeddings cho từng chunk và lưu vào MongoDB
    const chunksToCreate = [];
    for (const chunkText of chunks) {
      const embResult = await runEmbeddings(undefined, [chunkText]);
      const embeddingVector = embResult.vectors[0];
      chunksToCreate.push({
        documentId,
        content: chunkText,
        embedding: embeddingVector
      });
    }

    await prisma.documentChunk.createMany({
      data: chunksToCreate
    });

    res.status(201).json({ success: true, documentId, chunksCount: chunks.length });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 3. API: Xóa tài liệu khỏi MongoDB
ragRouter.delete('/documents/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    await getPrisma().document.delete({
      where: { id: id as string }
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

const querySchema = z.object({
  query: z.string().min(1),
  documentIds: z.array(z.string()).optional(), // MongoDB ObjectIDs dạng string
});

// 4. API: Truy vấn tìm kiếm các chunks tương đồng nhất (Semantic Search) sử dụng MongoDB
ragRouter.post('/query', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { query, documentIds } = parsed.data;
  const prisma = getPrisma();

  try {
    // 1. Tính embedding của câu hỏi
    const queryEmbResult = await runEmbeddings(undefined, [query]);
    const queryVector = queryEmbResult.vectors[0];

    // 2. Lấy toàn bộ chunks phù hợp từ MongoDB
    const chunksRows = await prisma.documentChunk.findMany({
      where: documentIds && documentIds.length > 0 ? {
        documentId: { in: documentIds }
      } : {},
      include: {
        document: {
          select: { filename: true }
        }
      }
    });

    // 3. Tính độ tương đồng cosine và sắp xếp
    const matchedChunks = chunksRows.map((row: any) => {
      const similarity = cosineSimilarity(queryVector, row.embedding);
      return {
        content: row.content,
        filename: row.document.filename,
        similarity,
      };
    })
    .filter((item: any) => item.similarity > 0.3) // Ngưỡng tương đồng tối thiểu
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, 4);

    res.json({ success: true, context: matchedChunks });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
