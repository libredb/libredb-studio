import { getSession } from '@/lib/auth';
import { NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  type MaintenanceType,
} from '@/lib/db';
import { getServerAuditBuffer } from '@/lib/audit';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';

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
    const body = await request.json();
    const { type, target } = body;

    const connection = await resolveConnection(body, session);

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

    const startTime = Date.now();
    const result = await provider.runMaintenance(type, target);
    const duration = Date.now() - startTime;

    // Emit audit event
    const audit = getServerAuditBuffer();
    audit.push({
      type: type === 'kill' ? 'kill_session' : 'maintenance',
      action: type.toUpperCase(),
      target: target || 'all',
      connectionName: connection.name || connection.database || 'unknown',
      user: session.username || 'admin',
      result: 'success',
      duration,
    });

    return NextResponse.json(result);
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/maintenance' });
  }
}
