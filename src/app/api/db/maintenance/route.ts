import { getSession } from '@/lib/auth';
import { NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  isDatabaseError,
  DatabaseConfigError,
  type MaintenanceType,
} from '@/lib/db';

export async function POST(request: Request) {
  // Check admin authorization
  const session = await getSession();

  if (!session || session.role !== 'admin') {
    return NextResponse.json(
      { error: 'Unauthorized. Admin access required.' },
      { status: 403 }
    );
  }

  try {
    const { type, target, connection } = await request.json();

    // Validate connection
    if (!connection) {
      return NextResponse.json(
        { error: 'Connection is required' },
        { status: 400 }
      );
    }

    if (!type) {
      return NextResponse.json(
        { error: 'Maintenance type is required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const capabilities = provider.getCapabilities();

    if (!capabilities.supportsMaintenance) {
      return NextResponse.json(
        { error: `Maintenance operations not supported for this database` },
        { status: 400 }
      );
    }

    if (!capabilities.maintenanceOperations.includes(type as MaintenanceType)) {
      return NextResponse.json(
        { error: `Operation '${type}' not supported for this database. Supported: ${capabilities.maintenanceOperations.join(', ')}` },
        { status: 400 }
      );
    }

    const result = await provider.runMaintenance(type, target);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[API:maintenance] Error:', error);

    if (error instanceof DatabaseConfigError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    if (isDatabaseError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 500 }
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
