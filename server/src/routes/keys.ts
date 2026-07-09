import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { getPrisma } from '../lib/prisma.js';
import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { parseKeysFromFile, stripJsoncComments, stripTrailingCommas } from '../lib/key-parser.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { syncApiKeys } from '../lib/key-sync.js';

import type { Platform } from '@freellmapi/shared';

export const keysRouter = Router();

const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aihorde', 'custom',
] as const;

const ALLOWED_IMPORT_EXTENSIONS = new Set(['.env', '.json', '.jsonc', '.md', '.txt', '.csv']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) {
      cb(new Error('Unsupported file type'));
      return;
    }
    cb(null, true);
  },
});

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

const importKeySchema = z.object({
  keyName: z.string().optional(),
  keyValue: z.string().min(1),
  platform: z.enum(PLATFORMS),
});

const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    displayName: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
  }),
]);

const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
}).refine(
  d => (d.model && d.model.trim().length > 0) || (d.models && d.models.length > 0),
  { message: 'model or models is required' },
);

function handleUploadError(err: any, res: Response, next: NextFunction): boolean {
  if (!err) return false;
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
    return true;
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    res.status(413).json({ error: { message: 'Too many files. Maximum is 10' } });
    return true;
  }
  if (err.message?.includes('Unsupported file type')) {
    res.status(400).json({ error: { message: 'Unsupported file type' } });
    return true;
  }
  next(err);
  return true;
}

function parseUpload(file: Express.Multer.File) {
  const content = file.buffer.toString('utf8');
  if (!content.trim()) {
    throw Object.assign(new Error('File contains no data'), { status: 400 });
  }
  if (/\.jsonc?$/i.test(file.originalname)) {
    try {
      JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
    } catch {
      throw Object.assign(new Error('Invalid JSON format'), { status: 400 });
    }
  }
  return parseKeysFromFile(content, file.originalname);
}

function splitRawKey(rawKey: string) {
  const eqIndex = rawKey.indexOf('=');
  return {
    keyName: eqIndex === -1 ? rawKey : rawKey.slice(0, eqIndex),
    keyValue: eqIndex === -1 ? '' : rawKey.slice(eqIndex + 1),
  };
}

async function insertImportedKey(platform: (typeof PLATFORMS)[number], keyName: string, keyValue: string) {
  if (platform === 'custom') {
    throw new Error('Custom providers must be added with a base URL');
  }
  if (!resolveProvider(platform as Platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const { encrypted, iv, authTag } = encrypt(keyValue.trim());
  await getPrisma().apiKey.create({
    data: {
      platform,
      label: keyName,
      encryptedKey: encrypted,
      iv,
      authTag,
      status: 'unknown',
      enabled: true
    }
  });
}

function enabledModelCount(platform: string): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS c FROM models WHERE platform = ? AND enabled = 1').get(platform) as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

function noModelsNotice(platform: string): string | undefined {
  if (enabledModelCount(platform) > 0) return undefined;
  return (
    `Key saved, but no ${platform} models are in your current catalog yet. ` +
    `Newer providers are published to the premium catalog first and appear ` +
    `for free-tier installs once they age into the monthly catalog. Add a ` +
    `Premium license key to use them now, or add ${platform} as a custom ` +
    `OpenAI-compatible provider with its base URL.`
  );
}

// List all keys
keysRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const rows = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const customModelsList: any[] = [];
    try {
      const db = getDb();
      const chatModels = db.prepare("SELECT key_id, id, 'chat' AS kind, model_id, display_name FROM models WHERE platform = 'custom'").all() as any[];
      customModelsList.push(...chatModels);
    } catch {
      // Ignored if local SQLite models table doesn't exist
    }

    const modelsByKeyId = new Map<string, any[]>();
    for (const m of customModelsList) {
      if (!m.key_id) continue;
      const keyIdStr = String(m.key_id);
      const list = modelsByKeyId.get(keyIdStr) ?? [];
      list.push({
        id: m.id,
        kind: m.kind,
        modelId: m.model_id,
        displayName: m.display_name,
        family: null
      });
      modelsByKeyId.set(keyIdStr, list);
    }

    const keys = rows.map((row: any) => {
      let maskedKey = '****';
      try {
        const realKey = decrypt(row.encryptedKey, row.iv, row.authTag);
        maskedKey = maskKey(realKey);
      } catch {
        maskedKey = '[decrypt failed]';
      }
      return {
        id: row.id,
        platform: row.platform,
        label: row.label,
        maskedKey,
        baseUrl: row.baseUrl,
        status: row.status,
        enabled: row.enabled,
        keyless: resolveProvider(row.platform as Platform)?.keyless === true,
        createdAt: row.createdAt,
        lastCheckedAt: row.lastCheckedAt,
        models: row.platform === 'custom' ? (modelsByKeyId.get(row.id) ?? []) : undefined,
      };
    });

    res.json(keys);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Export keys
keysRouter.get('/export', async (req: Request, res: Response) => {
  try {
    const format = (req.query.format as string) ?? 'json';
    const healthyOnly = req.query.healthy === 'true';

    const prisma = getPrisma();
    const rows = await prisma.apiKey.findMany({
      where: healthyOnly ? { status: 'healthy' } : {},
      orderBy: { platform: 'asc' }
    });

    const decryptedKeys = rows
      .map((row: any) => {
        let key = '';
        try {
          key = decrypt(row.encryptedKey, row.iv, row.authTag);
        } catch {
          key = '';
        }
        return {
          platform: row.platform,
          key,
          label: row.label || '',
          baseUrl: row.baseUrl || undefined,
        };
      })
      .filter((k: any) => {
        const v = k.key.trim();
        return v.length > 0 && v !== 'no-key';
      });

    if (decryptedKeys.length === 0) {
      res.status(404).json({ error: { message: 'No keys to export' } });
      return;
    }

    if (format === 'env') {
      const lines = decryptedKeys.map((k: any) => {
        const envKey = `${k.platform.toUpperCase()}_KEY=${k.key}`;
        return k.label ? `# ${k.label}\n${envKey}` : envKey;
      });
      const content = lines.join('\n\n') + '\n';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.env"');
      res.send(content);
      return;
    }

    if (format === 'csv') {
      const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
      const header = 'platform,key,label';
      const lines = decryptedKeys.map((k: any) =>
        [escCsv(k.platform), escCsv(k.key), escCsv(neutralize(k.label))].join(',')
      );
      const content = [header, ...lines].join('\n') + '\n';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.csv"');
      res.send(content);
      return;
    }

    const jsonExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'freellmapi',
      keys: decryptedKeys,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.json"');
    res.json(jsonExport);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Add a key
keysRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = addKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
      return;
    }

    const { platform, label } = parsed.data;
    const isKeyless = resolveProvider(platform as Platform)?.keyless === true;
    const rawKey = parsed.data.key?.trim() ?? '';

    if (!isKeyless && !rawKey) {
      res.status(400).json({ error: { message: 'key is required' } });
      return;
    }

    const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;
    const prisma = getPrisma();

    if (isKeyless) {
      const existing = await prisma.apiKey.findFirst({
        where: { platform }
      });
      if (existing) {
        const updated = await prisma.apiKey.update({
          where: { id: existing.id },
          data: { enabled: true, status: 'unknown' }
        });
        await syncApiKeys();
        res.status(200).json({
          id: updated.id,
          platform,
          label: label ?? '',
          maskedKey: maskKey(keyToStore),
          status: 'unknown',
          enabled: true,
          modelsAvailable: enabledModelCount(platform),
          notice: noModelsNotice(platform),
        });
        return;
      }
    }

    const { encrypted, iv, authTag } = encrypt(keyToStore);
    const created = await prisma.apiKey.create({
      data: {
        platform,
        label: label ?? '',
        encryptedKey: encrypted,
        iv,
        authTag,
        status: 'unknown',
        enabled: true
      }
    });

    await syncApiKeys();

    res.status(201).json({
      id: created.id,
      platform,
      label: label ?? '',
      maskedKey: maskKey(keyToStore),
      status: 'unknown',
      enabled: true,
      modelsAvailable: enabledModelCount(platform),
      notice: noModelsNotice(platform),
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Custom providers API router (Hybrid: ApiKey in MongoDB, models metadata registered in SQLite local temporarily)
keysRouter.post('/custom', async (req: Request, res: Response) => {
  try {
    const parsed = customProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
      return;
    }

    const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
    const verdict = await assessProviderUrl(baseUrl);
    if (!verdict.allowed) {
      res.status(400).json({ error: { message: `baseUrl rejected: ${verdict.reason}` } });
      return;
    }

    const providedKey = parsed.data.apiKey?.trim() || undefined;
    const label = parsed.data.label?.trim() || undefined;

    const topTools = parsed.data.supportsTools;
    const topVision = parsed.data.supportsVision;
    const entries: { modelId: string; displayName: string; supportsTools?: boolean; supportsVision?: boolean }[] = [];
    const seen = new Set<string>();
    const addEntry = (rawId: string, rawDisplay?: string, tools?: boolean, vision?: boolean) => {
      const modelId = rawId.trim();
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      entries.push({
        modelId,
        displayName: (rawDisplay?.trim() || modelId),
        supportsTools: tools ?? topTools,
        supportsVision: vision ?? topVision,
      });
    };
    if (parsed.data.model?.trim()) addEntry(parsed.data.model, parsed.data.displayName);
    for (const m of parsed.data.models ?? []) {
      if (typeof m === 'string') addEntry(m);
      else addEntry(m.model, m.displayName, m.supportsTools, m.supportsVision);
    }

    if (entries.length === 0) {
      res.status(400).json({ error: { message: 'model or models is required' } });
      return;
    }

    const prisma = getPrisma();
    const existing = await prisma.apiKey.findFirst({
      where: { platform: 'custom', baseUrl }
    });

    let keyId: string;
    let storedKeyForMask = providedKey ?? 'no-key';

    if (existing) {
      keyId = existing.id;
      if (providedKey) {
        const { encrypted, iv, authTag } = encrypt(providedKey);
        await prisma.apiKey.update({
          where: { id: existing.id },
          data: {
            label: label ?? undefined,
            encryptedKey: encrypted,
            iv,
            authTag,
            status: 'unknown',
            enabled: true
          }
        });
        storedKeyForMask = providedKey;
      } else {
        try {
          storedKeyForMask = decrypt(existing.encryptedKey, existing.iv, existing.authTag);
        } catch {
          storedKeyForMask = 'no-key';
        }
        await prisma.apiKey.update({
          where: { id: existing.id },
          data: {
            label: label ?? undefined,
            status: 'unknown',
            enabled: true
          }
        });
      }
    } else {
      const keyToStore = providedKey ?? 'no-key';
      const { encrypted, iv, authTag } = encrypt(keyToStore);
      const created = await prisma.apiKey.create({
        data: {
          platform: 'custom',
          label: label ?? 'Custom',
          encryptedKey: encrypted,
          iv,
          authTag,
          status: 'unknown',
          enabled: true,
          baseUrl
        }
      });
      keyId = created.id;
      storedKeyForMask = keyToStore;
    }

    // SQLite local models fallback binding
    const registered: any[] = [];
    try {
      const db = getDb();
      for (const { modelId, displayName, supportsTools, supportsVision } of entries) {
        const toolsParam = supportsTools === undefined ? null : (supportsTools ? 1 : 0);
        const visionParam = supportsVision === undefined ? null : (supportsVision ? 1 : 0);
        
        // key_id column accepts text or integer in SQLite depending on types, let's treat keyId as text binder
        db.prepare(`
          INSERT INTO models
            (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
             rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id,
             supports_tools, supports_vision)
          VALUES ('custom', @modelId, @displayName, 50, 50, 'Custom', NULL, NULL, NULL, NULL, '', NULL, 1, @keyId,
             COALESCE(@tools, 1), COALESCE(@vision, 0))
          ON CONFLICT(platform, model_id)
          DO UPDATE SET
            display_name = excluded.display_name,
            key_id = excluded.key_id,
            enabled = 1,
            supports_tools = COALESCE(@tools, supports_tools),
            supports_vision = COALESCE(@vision, supports_vision)
        `).run({ modelId, displayName, keyId, tools: toolsParam, vision: visionParam });

        const modelRow = db.prepare("SELECT id, supports_tools, supports_vision FROM models WHERE platform = 'custom' AND model_id = ?").get(modelId) as { id: number; supports_tools: number; supports_vision: number };
        
        // Append to local fallback config
        const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
        if (!inChain) {
          const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
          db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
        }

        registered.push({
          modelDbId: modelRow.id,
          model: modelId,
          displayName,
          supportsTools: modelRow.supports_tools === 1,
          supportsVision: modelRow.supports_vision === 1,
        });
      }
    } catch (sqliteErr) {
      console.error('Error binding models to local SQLite database:', sqliteErr);
    }

    await syncApiKeys();

    const first = registered[0] || { model: 'custom-model', displayName: 'Custom Model', modelDbId: 999, supportsTools: true, supportsVision: false };
    res.status(201).json({
      success: true,
      keyId,
      modelDbId: first.modelDbId,
      platform: 'custom',
      baseUrl,
      model: first.model,
      displayName: first.displayName,
      supportsTools: first.supportsTools,
      supportsVision: first.supportsVision,
      models: registered,
      maskedKey: maskKey(storedKeyForMask),
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Import key files
keysRouter.post('/import', (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, async (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'No file uploaded' } });
        return;
      }

      const result = parseUpload(req.file);
      const imported: Array<{ keyName: string; platform: string }> = [];
      const skipped = [...result.skipped];
      const errors: Array<{ key: string; error: string }> = [];

      for (const parsedKey of result.keys) {
        const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
        if (!parsedKey.platform) {
          skipped.push(keyName);
          continue;
        }
        const platformParse = z.enum(PLATFORMS).safeParse(parsedKey.platform);
        if (!platformParse.success || platformParse.data === 'custom') {
          skipped.push(keyName);
          continue;
        }
        if (!keyValue.trim()) {
          errors.push({ key: keyName, error: 'keyValue must be at least 1 character' });
          continue;
        }

        try {
          await insertImportedKey(platformParse.data, keyName, keyValue);
          imported.push({ keyName, platform: platformParse.data });
        } catch (insertErr) {
          errors.push({ key: keyName, error: (insertErr as Error).message });
        }
      }

      res.json({
        imported: imported.length,
        skipped,
        errors,
        total: result.keys.length + result.skipped.length,
      });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

// Preview files for import
keysRouter.post('/preview', (req: Request, res: Response, next: NextFunction) => {
  upload.array('files', 10)(req, res, async (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: { message: 'No files uploaded' } });
        return;
      }

      const keys: Array<{ keyName: string; keyValue: string; detectedPlatform: string | null; prefix: string; isDuplicate: boolean }> = [];
      const skipped: string[] = [];

      // Fetch all encrypted keys from MongoDB
      const prisma = getPrisma();
      const existingRows = await prisma.apiKey.findMany();
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        try {
          existingKeys.add(decrypt(row.encryptedKey, row.iv, row.authTag));
        } catch { /* skip */ }
      }

      let duplicateCount = 0;

      for (const file of files) {
        const result = parseUpload(file);
        for (const parsedKey of result.keys) {
          const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
          const isDuplicate = existingKeys.has(keyValue.trim());
          if (isDuplicate) duplicateCount++;
          keys.push({
            keyName,
            keyValue,
            detectedPlatform: parsedKey.platform,
            prefix: parsedKey.prefix,
            isDuplicate,
          });
        }
        skipped.push(...result.skipped);
      }

      res.json({ keys, total: keys.length, skipped, duplicates: duplicateCount });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

// Import selected keys
keysRouter.post('/import-selected', async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ keys: z.array(importKeySchema).max(100) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
      return;
    }

    let imported = 0;
    let duplicateSkipped = 0;
    const errors: Array<{ key: string; error: string }> = [];

    const prisma = getPrisma();
    const existingRows = await prisma.apiKey.findMany();
    const existingKeys = new Set<string>();
    for (const row of existingRows) {
      try {
        existingKeys.add(decrypt(row.encryptedKey, row.iv, row.authTag));
      } catch { /* skip */ }
    }

    for (const key of parsed.data.keys) {
      const keyName = key.keyName?.trim() || key.platform;
      if (key.platform === 'custom') {
        errors.push({ key: keyName, error: 'Custom providers must be added with a base URL' });
        continue;
      }

      if (existingKeys.has(key.keyValue.trim())) {
        duplicateSkipped++;
        errors.push({ key: keyName, error: 'Duplicate key — already exists' });
        continue;
      }

      try {
        await insertImportedKey(key.platform, keyName, key.keyValue);
        imported++;
        existingKeys.add(key.keyValue.trim());
      } catch (err) {
        errors.push({ key: keyName, error: (err as Error).message });
      }
    }

    await syncApiKeys();

    res.json({
      imported,
      skipped: [],
      errors,
      total: parsed.data.keys.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Delete a key
keysRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params.id; // String id in MongoDB ObjectId
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  try {
    const prisma = getPrisma();
    const row = await prisma.apiKey.findUnique({
      where: { id: id as string }
    });
    if (!row) {
      res.status(404).json({ error: { message: 'Key not found' } });
      return;
    }

    await prisma.apiKey.delete({
      where: { id: id as string }
    });

    // Local custom models cleanup in SQLite
    if (row.platform === 'custom') {
      try {
        const db = getDb();
        db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(id);
        db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(id);
        
        const remaining = await prisma.apiKey.count({
          where: { platform: 'custom' }
        });
        if (remaining === 0) {
          db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
          db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
        }
      } catch (sqliteErr) {
        console.error('Error cleaning custom models from SQLite:', sqliteErr);
      }
    }

    await syncApiKeys();

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', async (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  try {
    const prisma = getPrisma();
    const result = await prisma.apiKey.updateMany({
      where: { platform },
      data: { enabled }
    });
    await syncApiKeys();
    res.json({ success: true, enabled, updatedKeys: result.count });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Update key enabled state or label
keysRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  try {
    const prisma = getPrisma();
    const updated = await prisma.apiKey.update({
      where: { id: id as string },
      data: {
        enabled: enabled ?? undefined,
        label: label ?? undefined
      }
    });

    const response: Record<string, unknown> = { success: true };
    if (enabled !== undefined) response.enabled = updated.enabled;
    if (label !== undefined) response.label = updated.label;
    await syncApiKeys();
    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
