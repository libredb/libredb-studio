import { login } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

interface AuthUser {
  email: string;
  password: string;
  role: 'admin' | 'user';
}

function getAuthUsers(): AuthUser[] {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@libredb.org';
  const adminPassword = process.env.ADMIN_PASSWORD;
  const userEmail = process.env.USER_EMAIL || 'user@libredb.org';
  const userPassword = process.env.USER_PASSWORD;

  // Passwords MUST come from the environment in every environment. Never fall
  // back to a hardcoded default — a baked-in password would be a publicly known
  // credential on any deployment that forgets to set ADMIN_PASSWORD/USER_PASSWORD.
  if (!adminPassword || !userPassword) {
    throw new Error(
      'ADMIN_PASSWORD and USER_PASSWORD environment variables are required'
    );
  }

  return [
    {
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
    },
    {
      email: userEmail,
      password: userPassword,
      role: 'user',
    },
  ];
}

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    const users = getAuthUsers();

    const matched = users.find(
      (u) => u.email === email && u.password === password
    );

    if (matched) {
      await login(matched.role, matched.email);
      return NextResponse.json({ success: true, role: matched.role });
    }

    logger.warn('Failed login attempt', { route: 'POST /api/auth/login', email });
    return NextResponse.json(
      { success: false, message: 'Invalid email or password' },
      { status: 401 }
    );
  } catch (error) {
    return createErrorResponse(error, { route: 'POST /api/auth/login' });
  }
}
