import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db/factory';
import { createErrorResponse } from '@/lib/api/errors';

export async function POST(req: NextRequest) {
  try {
    const { connection, tableName, columns } = await req.json();

    if (!connection || !tableName) {
      return NextResponse.json({ error: 'Connection and tableName required' }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);

    {
      const capabilities = provider.getCapabilities();
      const isSQL = capabilities.queryLanguage === 'sql';

      if (!isSQL) {
        // MongoDB profiling
        const profileQuery = JSON.stringify({
          collection: tableName,
          operation: 'aggregate',
          pipeline: [
            { $sample: { size: 1000 } },
            { $project: Object.fromEntries((columns || []).map((c: string) => [c, 1])) },
          ],
        });
        const sampleResult = await provider.query(profileQuery);
        const totalCountResult = await provider.query(JSON.stringify({
          collection: tableName,
          operation: 'countDocuments',
          filter: {},
        }));

        const totalRows = totalCountResult.rows[0]?.count || sampleResult.rows.length;
        const columnProfiles = (columns || []).map((col: string) => {
          const values = sampleResult.rows.map(r => r[col]).filter(v => v !== undefined);
          const nullCount = sampleResult.rows.length - values.length;
          const distinctValues = new Set(values.map(v => JSON.stringify(v)));

          return {
            name: col,
            type: typeof values[0] || 'unknown',
            totalRows,
            nullCount,
            nullPercent: sampleResult.rows.length > 0 ? Math.round((nullCount / sampleResult.rows.length) * 100) : 0,
            distinctCount: distinctValues.size,
            sampleValues: values.slice(0, 5).map(v => String(v)),
          };
        });

        return NextResponse.json({ tableName, totalRows, columns: columnProfiles });
      }

      // SQL profiling
      const colList = (columns || []) as string[];
      if (colList.length === 0) {
        return NextResponse.json({ error: 'No columns to profile' }, { status: 400 });
      }

      // Get total row count
      const countResult = await provider.query(`SELECT COUNT(*) as total FROM ${tableName}`);
      const totalRows = Number(countResult.rows[0]?.total || 0);

      // Build profiling query for each column
      const profileParts = colList.slice(0, 20).map((col) => {
        const safeCol = `"${col}"`;
        return `
          SELECT
            '${col.replace(/'/g, "''")}' as column_name,
            COUNT(*) as total_count,
            COUNT(${safeCol}) as non_null_count,
            COUNT(*) - COUNT(${safeCol}) as null_count,
            COUNT(DISTINCT ${safeCol}) as distinct_count,
            MIN(${safeCol}::text) as min_value,
            MAX(${safeCol}::text) as max_value
          FROM ${tableName}
        `;
      });

      const columnProfiles: { name: string; totalRows: number; nullCount: number; nullPercent: number; distinctCount: number; minValue?: unknown; maxValue?: unknown; error?: string; sampleValues?: string[] }[] = [];

      for (const sql of profileParts) {
        try {
          const result = await provider.query(sql);
          const row = result.rows[0];
          if (row) {
            const nullCount = Number(row.null_count || 0);
            const total = Number(row.total_count || 0);

            columnProfiles.push({
              name: String(row.column_name),
              totalRows: total,
              nullCount,
              nullPercent: total > 0 ? Math.round((nullCount / total) * 100) : 0,
              distinctCount: Number(row.distinct_count || 0),
              minValue: row.min_value,
              maxValue: row.max_value,
            });
          }
        } catch {
          // Skip columns that can't be profiled (e.g., binary)
          columnProfiles.push({
            name: colList[columnProfiles.length],
            totalRows,
            nullCount: 0,
            nullPercent: 0,
            distinctCount: 0,
            error: 'Could not profile this column',
          });
        }
      }

      // Get sample values for top 5 columns
      const topCols = colList.slice(0, 5);
      const safeCols = topCols.map(c => `"${c}"`).join(', ');
      try {
        const sampleResult = await provider.query(
          `SELECT ${safeCols} FROM ${tableName} LIMIT 5`
        );
        for (const profile of columnProfiles) {
          if (topCols.includes(profile.name)) {
            profile.sampleValues = sampleResult.rows.map(r => String(r[profile.name] ?? 'NULL')).slice(0, 5);
          }
        }
      } catch { /* skip sample values on error */ }

      return NextResponse.json({ tableName, totalRows, columns: columnProfiles });
    }
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/profile' });
  }
}
