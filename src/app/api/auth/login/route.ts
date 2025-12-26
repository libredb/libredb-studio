import { login } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

function getAuthPasswords() {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const userPassword = process.env.USER_PASSWORD;
  
  if (process.env.NODE_ENV === 'production') {
    if (!adminPassword || !userPassword) {
      throw new Error('ADMIN_PASSWORD and USER_PASSWORD environment variables are required in production');
    }
  }
  
  return {
    admin: adminPassword || 'admin123',
    user: userPassword || 'user123',
  };
}

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();
    const passwords = getAuthPasswords();
    
    const ADMIN_PASSWORD = passwords.admin;
    const USER_PASSWORD = passwords.user;

    if (password === ADMIN_PASSWORD) {
      await login('admin');
      return NextResponse.json({ success: true, role: 'admin' });
    }

    if (password === USER_PASSWORD) {
      await login('user');
      return NextResponse.json({ success: true, role: 'user' });
    }

    return NextResponse.json(
      { success: false, message: 'Invalid password' },
      { status: 401 }
    );
  } catch {
    return NextResponse.json(
      { success: false, message: 'An error occurred' },
      { status: 500 }
    );
  }
}
