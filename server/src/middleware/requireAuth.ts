import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';
import { getDb } from '../db/index.js';

export interface ExtendedSessionUser {
  userId: number;
  email: string;
  role: string;
}

// Gate the /api/* admin surface behind a dashboard session.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }

  // Fetch the role of the user from database
  let role = 'user';
  try {
    const userRow = getDb().prepare('SELECT role FROM users WHERE id = ?').get(session.userId) as { role: string } | undefined;
    if (userRow) {
      role = userRow.role;
    }
  } catch (err) {
    // Fallback if column does not exist yet (before migration runs fully)
  }

  (req as Request & { user?: ExtendedSessionUser }).user = {
    ...session,
    role,
  };
  next();
}

// Middleware to verify roles
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: ExtendedSessionUser }).user;
    if (!user || !allowedRoles.includes(user.role)) {
      res.status(403).json({ error: { message: 'Permission denied', type: 'authorization_error' } });
      return;
    }
    next();
  };
}

