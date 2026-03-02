import { login } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

interface AuthUser {
  email: string;
  password: string;
  role: 'admin' | 'user';
}

function getAuthUsers(): AuthUser[] {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const userEmail = process.env.USER_EMAIL;
  const userPassword = process.env.USER_PASSWORD;

  if (process.env.NODE_ENV === 'production') {
    if (!adminEmail || !adminPassword || !userEmail || !userPassword) {
      throw new Error(
        'ADMIN_EMAIL, ADMIN_PASSWORD, USER_EMAIL, and USER_PASSWORD environment variables are required in production'
      );
    }
  }

  return [
    {
      email: adminEmail || 'admin@libredb.org',
      password: adminPassword || 'LibreDB.2026',
      role: 'admin',
    },
    {
      email: userEmail || 'user@libredb.org',
      password: userPassword || 'LibreDB.2026',
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

    return NextResponse.json(
      { success: false, message: 'Invalid email or password' },
      { status: 401 }
    );
  } catch {
    return NextResponse.json(
      { success: false, message: 'An error occurred' },
      { status: 500 }
    );
  }
}
