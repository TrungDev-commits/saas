import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '../lib/prisma.js';
import {
  userCount,
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
  deleteSession,
} from '../services/auth.js';
import { setupCodeMatches, clearSetupCode } from '../lib/setup-code.js';

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(email: string): boolean {
  const a = attempts.get(email.toLowerCase());
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const key = email.toLowerCase();
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
}
function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

function isLoopbackRemote(req: Request): boolean {
  let addr = req.socket.remoteAddress ?? '';
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

authRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const session = await validateSession(bearer(req));
    let role = null;
    if (session) {
      const user = await getPrisma().user.findUnique({
        where: { id: session.userId },
        select: { role: true }
      });
      role = user?.role ?? 'user';
    }
    const count = await userCount();
    res.json({
      needsSetup: count === 0,
      authenticated: !!session,
      email: session?.email ?? null,
      role,
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

authRouter.post('/setup', async (req: Request, res: Response) => {
  try {
    const count = await userCount();
    if (count > 0) {
      clearSetupCode();
      res.status(409).json({ error: { message: 'Setup already completed. Use login instead.', type: 'setup_complete' } });
      return;
    }

    if (!isLoopbackRemote(req) && !setupCodeMatches((req.body ?? {}).setupCode)) {
      res.status(403).json({
        error: {
          message: 'A setup code is required to create the first account from a remote device.',
          type: 'setup_code_required',
        },
      });
      return;
    }

    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
      return;
    }
    
    const user = await createUser(parsed.data.email, parsed.data.password, 'admin');
    clearSetupCode();
    const token = await createSession(user.userId);
    res.status(201).json({ token, email: user.email, role: 'admin' });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
      return;
    }
    const { email, password } = parsed.data;

    if (isLockedOut(email)) {
      res.status(429).json({ error: { message: 'Too many failed attempts. Try again later.', type: 'rate_limit_error' } });
      return;
    }

    const user = await verifyCredentials(email, password);
    if (!user) {
      recordFailure(email);
      res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
      return;
    }

    clearFailures(email);
    const token = await createSession(user.userId);
    
    const userRow = await getPrisma().user.findUnique({
      where: { id: user.userId },
      select: { role: true }
    });
    const role = userRow?.role ?? 'user';
    
    res.json({ token, email: user.email, role });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    await deleteSession(bearer(req));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const session = await validateSession(bearer(req));
    if (!session) {
      res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
      return;
    }
    const user = await getPrisma().user.findUnique({
      where: { id: session.userId },
      select: { role: true }
    });
    const role = user?.role ?? 'user';
    res.json({ email: session.email, role });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
