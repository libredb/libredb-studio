import { NextRequest, NextResponse } from 'next/server';
import { createLLMProvider } from '@/lib/llm';
import { createErrorResponse } from '@/lib/api/errors';

function buildImpactSystemPrompt(databaseType: string, schemaContext: string): string {
  return `You are a Schema Change Impact Analyst for ${databaseType || 'PostgreSQL'}. You analyze DDL statements BEFORE they are executed and predict their impact.

DATABASE TYPE: ${databaseType || 'PostgreSQL'}

SCHEMA CONTEXT:
${schemaContext || 'No schema available.'}

ANALYSIS SCOPE:
1. **Lock Impact**: Will this statement acquire table locks? For how long? What queries will be blocked?
2. **Data Impact**: Will data be lost? How many rows affected? Are there cascade effects?
3. **Dependent Objects**: Views, indexes, triggers, functions that depend on the modified object
4. **Performance Impact**: Will queries become slower after this change? Will indexes need rebuilding?
5. **Rollback Plan**: How to reverse this change if something goes wrong

OUTPUT FORMAT (markdown):

## Impact Summary
One-line: what this DDL does and its risk level (Low/Medium/High/Critical).

## Lock Analysis
- Lock type acquired (ACCESS EXCLUSIVE, ROW EXCLUSIVE, etc.)
- Estimated duration for the schema context
- Affected concurrent queries

## Data Impact
- Rows affected (estimate)
- Data loss risk (none/potential/certain)
- Cascade effects (FK constraints)

## Dependent Objects
List views, indexes, triggers, stored procedures that reference the modified table/column.

## Validation Queries
SQL queries the user can run BEFORE applying the change to verify safety:
\`\`\`sql
-- Check for NULL values before adding NOT NULL constraint
SELECT COUNT(*) FROM table WHERE column IS NULL;
\`\`\`

## Rollback Plan
\`\`\`sql
-- Exact SQL to reverse this change
\`\`\`

## Recommendation
Whether to proceed, modify, or avoid this change. Suggest safer alternatives if applicable.

GUIDELINES:
- Be specific about ${databaseType} lock behavior
- For ALTER TABLE on large tables, warn about lock time
- For DROP operations, list ALL dependent objects
- For column type changes, check for data truncation risks
- Always provide a rollback plan
`;
}

export async function POST(req: NextRequest) {
  try {
    const { query, schemaContext, databaseType } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const provider = await createLLMProvider();
    const systemPrompt = buildImpactSystemPrompt(databaseType, schemaContext);

    const userMessage = `Analyze the impact of this schema change before I execute it:

\`\`\`sql
${query}
\`\`\`

Provide a comprehensive impact analysis.`;

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
    return createErrorResponse(error, { route: 'api/ai/impact' });
  }
}
