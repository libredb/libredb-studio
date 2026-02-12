import { NextRequest, NextResponse } from 'next/server';
import {
  createLLMProvider,
  LLMError,
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMConfigError,
} from '@/lib/llm';

function buildIndexAdvisorPrompt(databaseType: string): string {
  return `You are a Database Index Optimization Expert for ${databaseType || 'PostgreSQL'}.

You will be given:
1. Slow queries with execution statistics
2. Current index statistics (scans, usage ratio)
3. Table statistics (row counts, sizes)
4. Schema information

Your job is to provide actionable index recommendations.

OUTPUT FORMAT (use markdown):

## Index Analysis Summary
Brief overview of the indexing health.

## Missing Indexes (Recommended to Create)
For each recommendation:
### Index: \`index_name\`
- **Table:** table_name
- **Columns:** column(s) to index
- **Reason:** Why this index is needed (reference the slow query)
- **Expected Impact:** How much improvement
- **SQL:**
\`\`\`sql
CREATE INDEX index_name ON table_name (columns);
\`\`\`

## Unused Indexes (Consider Dropping)
For each unused index:
- **Index:** index_name on table_name
- **Size:** index size
- **Scans:** 0 (never used)
- **Recommendation:** DROP or keep (with reason)

## Duplicate / Overlapping Indexes
If any indexes cover the same columns.

## Quick Wins
Top 3 most impactful changes, numbered.

GUIDELINES:
- Recommend composite indexes when queries filter on multiple columns
- Consider partial indexes for filtered queries
- For ${databaseType}, use appropriate index types (btree, hash, gin, gist)
- Always name indexes descriptively: idx_tablename_columns
- Note if ANALYZE/VACUUM should be run first
`;
}

export async function POST(req: NextRequest) {
  try {
    const { slowQueries, indexStats, tableStats, schemaContext, databaseType } = await req.json();

    const provider = await createLLMProvider();
    const systemPrompt = buildIndexAdvisorPrompt(databaseType);

    const parts: string[] = [];

    if (slowQueries?.length) {
      parts.push('## Slow Queries\n' + JSON.stringify(slowQueries.slice(0, 20), null, 2));
    }

    if (indexStats?.length) {
      parts.push('## Current Indexes\n' + JSON.stringify(indexStats.slice(0, 50), null, 2));
    }

    if (tableStats?.length) {
      parts.push('## Table Statistics\n' + JSON.stringify(tableStats.slice(0, 30), null, 2));
    }

    if (schemaContext) {
      parts.push('## Schema\n' + schemaContext.substring(0, 4000));
    }

    const userMessage = `Analyze the following database statistics and provide index recommendations:\n\n${parts.join('\n\n')}`;

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
    console.error('[AI:index-advisor] Error:', error);

    if (error instanceof LLMConfigError) return NextResponse.json({ error: error.message }, { status: 500 });
    if (error instanceof LLMAuthError) return NextResponse.json({ error: 'Invalid API key.' }, { status: 401 });
    if (error instanceof LLMRateLimitError) return NextResponse.json({ error: 'Rate limit reached.' }, { status: 429 });
    if (error instanceof LLMSafetyError) return NextResponse.json({ error: 'Blocked by safety filters.' }, { status: 400 });
    if (error instanceof LLMError) return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 });

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
