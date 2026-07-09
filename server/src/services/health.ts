import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import type { Scheduler } from '../lib/scheduler.js';
import { getPrisma } from '../lib/prisma.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Track consecutive failures per key
const failureCount = new Map<number | string, number>();

export async function checkKeyHealth(keyId: string | number): Promise<KeyStatus> {
  const db = getDb();
  let row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) {
    row = db.prepare('SELECT * FROM api_keys WHERE mongo_id = ?').get(keyId) as any;
  }
  if (!row) return 'error';

  const sqliteId = row.id;
  const mongoId = row.mongo_id; // could be null if local only

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId: sqliteId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'health',
    });

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, sqliteId);

    // Synchronize to MongoDB/Prisma
    if (mongoId) {
      try {
        const isAutoDisable = !isValid && (failureCount.get(sqliteId) ?? 0) + 1 >= CONSECUTIVE_FAILURES_TO_DISABLE;
        await getPrisma().apiKey.update({
          where: { id: mongoId },
          data: {
            status,
            lastCheckedAt: new Date(),
            enabled: isAutoDisable ? false : undefined
          }
        });
      } catch (mongoErr: any) {
        console.error(`[Health] Failed to update MongoDB status for key ${mongoId}:`, mongoErr.message);
      }
    }

    if (isValid) {
      failureCount.delete(sqliteId);
    } else {
      const count = (failureCount.get(sqliteId) ?? 0) + 1;
      failureCount.set(sqliteId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(sqliteId);
        console.log(`[Health] Auto-disabled key ${sqliteId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    // Include platform + base_url so a flapping CloudFront edge or DNS failure is
    // attributable to the responsible provider in one log read. The leading
    // "[Health] Key N (" prefix is preserved so the 12-hourly crash watchdog
    // (cron bff5ae167d28) that scrapes /tmp/freellmapi.log for these lines
    // continues to match unchanged.
    console.error(
      `[Health] Key ${sqliteId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${err.message}`,
    );
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', sqliteId);

    // Synchronize error status to MongoDB/Prisma
    if (mongoId) {
      try {
        await getPrisma().apiKey.update({
          where: { id: mongoId },
          data: {
            status: 'error',
            lastCheckedAt: new Date()
          }
        });
      } catch (mongoErr: any) {
        console.error(`[Health] Failed to update MongoDB status for key ${mongoId}:`, mongoErr.message);
      }
    }

    return 'error';
  }
}

export async function checkAllKeys(): Promise<void> {
  const db = getDb();
  const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

  console.log(`[Health] Checking ${keys.length} keys...`);

  for (const key of keys) {
    await checkKeyHealth(key.id);
  }

  console.log(`[Health] Check complete.`);
}

let cancelHealthCheck: (() => void) | null = null;

export function startHealthChecker(scheduler: Scheduler): void {
  if (cancelHealthCheck) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  cancelHealthCheck = scheduler.every(CHECK_INTERVAL_MS, () =>
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err)),
  );
}

export function stopHealthChecker(): void {
  if (cancelHealthCheck) {
    cancelHealthCheck();
    cancelHealthCheck = null;
  }
}
