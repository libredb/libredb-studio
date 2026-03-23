import { NextRequest, NextResponse } from 'next/server';
import { createLLMProvider } from '@/lib/llm';
import { createErrorResponse } from '@/lib/api/errors';

function buildSafetySystemPrompt(databaseType: string, schemaContext: string): string {
  return `You are a Database Safety Analyst. Your job is to analyze SQL queries BEFORE they are executed and warn the user about potential dangers.

DATABASE TYPE: ${databaseType || 'PostgreSQL'}

SCHEMA CONTEXT:
${schemaContext || 'No schema available.'}

ANALYSIS RULES:
1. Check for destructive operations: DROP, TRUNCATE, DELETE without WHERE, UPDATE without WHERE
2. Estimate affected row counts based on schema info
3. Check for cascade effects (FK constraints)
4. Detect risky patterns: Cartesian joins, unbounded deletes, mass updates
5. Check for schema modifications that could lock tables

OUTPUT FORMAT (always use this JSON structure, wrapped in a code block):
\`\`\`json
{
  "riskLevel": "safe" | "low" | "medium" | "high" | "critical",
  "summary": "One-line summary of the risk",
  "warnings": [
    {
      "type": "destructive" | "performance" | "schema" | "data_loss" | "lock",
      "severity": "info" | "warning" | "critical",
      "message": "What the issue is",
      "detail": "Why it matters and estimated impact"
    }
  ],
  "affectedRows": "estimated number or range, e.g. '~12,000' or 'all rows'",
  "cascadeEffects": "Description of cascade effects or 'none'",
  "recommendation": "What the user should do instead or how to make it safer"
}
\`\`\`

GUIDELINES:
- Be conservative: when in doubt, flag it
- For SELECT queries, riskLevel is always "safe"
- For INSERT, riskLevel is typically "low" unless it's INSERT INTO ... SELECT without limits
- DELETE without WHERE is ALWAYS "critical"
- DROP TABLE is ALWAYS "critical"
- UPDATE without WHERE is ALWAYS "high"
- TRUNCATE is ALWAYS "high"
- ALTER TABLE on large tables (>100K rows) is "medium" due to lock time
- Always return valid JSON in the code block
`;
}

export async function POST(req: NextRequest) {
  try {
    const { query, schemaContext, databaseType } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const provider = await createLLMProvider();
    const systemPrompt = buildSafetySystemPrompt(databaseType, schemaContext);

    const userMessage = `Analyze this query for safety before execution:

\`\`\`sql
${query}
\`\`\`

Return your analysis as a JSON code block.`;

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
    return createErrorResponse(error, { route: 'api/ai/query-safety' });
  }
}
