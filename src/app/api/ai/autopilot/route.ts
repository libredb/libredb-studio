import { NextRequest } from 'next/server';
import { createLLMProvider } from '@/lib/llm';
import { createErrorResponse } from '@/lib/api/errors';

function buildAutopilotPrompt(databaseType: string): string {
  return `You are a Database Performance Autopilot for ${databaseType || 'PostgreSQL'}. You combine slow query analysis, execution plans, table statistics, and index usage into a comprehensive optimization report.

OUTPUT FORMAT (markdown):

## Performance Score
Give a score out of 100 based on the overall health metrics. Use emoji: >=80 green, 60-79 yellow, <60 red.

## Critical Issues
Issues that need immediate attention (blocking queries, high bloat, cache miss rates).

## Top Slow Queries
For each slow query (top 5):
### Query #N
- **Avg Time:** Xms (Y calls)
- **Issue:** What's making it slow
- **Fix:**
\`\`\`sql
-- Optimized version or CREATE INDEX suggestion
\`\`\`

## Index Recommendations
Consolidated index suggestions from the slow query analysis.

## Maintenance Tasks
Recommended VACUUM, ANALYZE, REINDEX operations with priority.

## Configuration Suggestions
Any ${databaseType} configuration parameters that might improve performance based on the metrics.

## Action Plan
Numbered priority list of what to do first, second, third.

GUIDELINES:
- Be actionable: every recommendation should have a concrete SQL command
- Prioritize by impact: fix the biggest bottleneck first
- Consider trade-offs: new indexes use space, VACUUM needs downtime
- For ${databaseType}, use database-specific features and best practices
`;
}

export async function POST(req: NextRequest) {
  try {
    const {
      slowQueries,
      indexStats,
      tableStats,
      performanceMetrics,
      overview,
      schemaContext,
      databaseType
    } = await req.json();

    const provider = await createLLMProvider();
    const systemPrompt = buildAutopilotPrompt(databaseType);

    const parts: string[] = [];

    if (overview) {
      parts.push('## Database Overview\n' + JSON.stringify(overview, null, 2));
    }

    if (performanceMetrics) {
      parts.push('## Performance Metrics\n' + JSON.stringify(performanceMetrics, null, 2));
    }

    if (slowQueries?.length) {
      parts.push('## Slow Queries (Top 20)\n' + JSON.stringify(slowQueries.slice(0, 20), null, 2));
    }

    if (indexStats?.length) {
      parts.push('## Index Statistics\n' + JSON.stringify(indexStats.slice(0, 50), null, 2));
    }

    if (tableStats?.length) {
      parts.push('## Table Statistics\n' + JSON.stringify(tableStats.slice(0, 30), null, 2));
    }

    if (schemaContext) {
      parts.push('## Schema\n' + schemaContext.substring(0, 3000));
    }

    const userMessage = `Analyze the following database metrics and provide a comprehensive performance optimization report:\n\n${parts.join('\n\n')}`;

    const stream = await provider.stream({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    return createErrorResponse(error, { route: 'api/ai/autopilot' });
  }
}
