import crypto from 'crypto';
import { getPrisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication via MongoDB (Prisma)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  userId: string;
  email: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function userCount(): Promise<number> {
  return getPrisma().user.count();
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export async function createUser(email: string, password: string, role = 'user'): Promise<SessionUser> {
  const prisma = getPrisma();
  const normalized = normalizeEmail(email);
  const existing = await prisma.user.findUnique({
    where: { email: normalized }
  });
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  const user = await prisma.user.create({
    data: {
      email: normalized,
      passwordHash: hashPassword(password),
      role
    }
  });
  return { userId: user.id, email: user.email };
}

/** Verify credentials. Returns the user on success, null on failure. */
export async function verifyCredentials(email: string, password: string): Promise<SessionUser | null> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) }
  });
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { userId: user.id, email: user.email };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAtMs = BigInt(Date.now() + SESSION_TTL_MS);
  
  await getPrisma().session.create({
    data: {
      tokenHash,
      userId,
      expiresAtMs
    }
  });
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export async function validateSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const prisma = getPrisma();
  const tokenHash = sha256(token);
  
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true }
  });
  
  if (!session) return null;
  if (session.expiresAtMs < BigInt(Date.now())) {
    await prisma.session.delete({
      where: { tokenHash }
    });
    return null;
  }
  return { userId: session.user.id, email: session.user.email };
}

export async function deleteSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const prisma = getPrisma();
  const tokenHash = sha256(token);
  try {
    await prisma.session.delete({
      where: { tokenHash }
    });
  } catch (err) {
    // Ignore if already deleted
  }
}
