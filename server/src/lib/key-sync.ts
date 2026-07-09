import { getPrisma } from './prisma.js';
import { getDb } from '../db/index.js';

export async function syncApiKeys(): Promise<void> {
  const prisma = getPrisma();
  const db = getDb();

  try {
    // Ensure mongo_id column exists in SQLite api_keys table
    const columns = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
    if (!columns.some(col => col.name === 'mongo_id')) {
      db.prepare('ALTER TABLE api_keys ADD COLUMN mongo_id TEXT').run();
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_mongo_id ON api_keys(mongo_id)').run();
    }

    const mongoKeys = await prisma.apiKey.findMany();
    const mongoKeyIds = new Set(mongoKeys.map(k => k.id));

    db.transaction(() => {
      // 1. Delete SQLite keys that are not in MongoDB
      const sqliteKeys = db.prepare('SELECT id, mongo_id FROM api_keys').all() as { id: number; mongo_id: string | null }[];
      for (const key of sqliteKeys) {
        if (!key.mongo_id || !mongoKeyIds.has(key.mongo_id)) {
          db.prepare('DELETE FROM api_keys WHERE id = ?').run(key.id);
        }
      }

      // 2. Upsert MongoDB keys into SQLite
      for (const k of mongoKeys) {
        const enabledVal = k.enabled ? 1 : 0;
        const lastCheckedStr = k.lastCheckedAt ? k.lastCheckedAt.toISOString() : null;
        const existing = db.prepare('SELECT id FROM api_keys WHERE mongo_id = ?').get(k.id) as { id: number } | undefined;

        if (existing) {
          db.prepare(`
            UPDATE api_keys
               SET platform = ?, label = ?, encrypted_key = ?, iv = ?, auth_tag = ?, status = ?, enabled = ?, base_url = ?, last_checked_at = ?
             WHERE id = ?
          `).run(
            k.platform,
            k.label,
            k.encryptedKey,
            k.iv,
            k.authTag,
            k.status,
            enabledVal,
            k.baseUrl,
            lastCheckedStr,
            existing.id
          );
        } else {
          db.prepare(`
            INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, last_checked_at, mongo_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            k.platform,
            k.label,
            k.encryptedKey,
            k.iv,
            k.authTag,
            k.status,
            enabledVal,
            k.baseUrl,
            lastCheckedStr,
            k.id
          );
        }
      }
    })();
    console.log(`[key-sync] Synchronized ${mongoKeys.length} keys from MongoDB to SQLite.`);
  } catch (err: any) {
    console.error('[key-sync] Synchronization failed:', err.message);
  }
}
