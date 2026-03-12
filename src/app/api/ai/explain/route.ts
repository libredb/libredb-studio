import { NextRequest, NextResponse } from 'next/server';
import { createLLMProvider } from '@/lib/llm';
import { createErrorResponse } from '@/lib/api/errors';

function buildExplainSystemPrompt(databaseType: string, schemaContext: string): string {
  return `You are an Expert Database Performance Analyst specializing in query optimization for ${databaseType || 'PostgreSQL'}.

ROLE: Analyze EXPLAIN plans and provide actionable, plain-language explanations.

SCHEMA CONTEXT:
${schemaContext || 'No schema context available.'}

OUTPUT FORMAT (always follow this structure):

## Plain Language Explanation
Explain what the query does step-by-step in simple terms anyone can understand. Be specific about which tables, joins, and filters are involved.

## Performance Issues
List any problems found (sequential scans on large tables, expensive sorts, nested loop issues, row estimate mismatches). For each issue:
- What the problem is
- Why it matters
- How much impact it has

## Recommendations
Numbered list of concrete, actionable suggestions. Each should include:
- The specific action (e.g., "Create an index on orders.customer_id")
- Expected improvement
- The exact SQL command if applicable

## Optimized Query
If the query can be rewritten for better performance, provide the optimized version in a SQL code block. If the query is already optimal, say so.

GUIDELINES:
- Be concise but thorough
- Use plain language, avoid jargon where possible
- Quantify impact when you can (e.g., "reduces from table scan of ~100K rows to index lookup")
- If there are no issues, say the query looks good and explain why
- Format SQL in code blocks with \`\`\`sql
`;
}

export async function POST(req: NextRequest) {
  try {
    const { query, explainPlan, schemaContext, databaseType } = await req.json();

    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      );
    }

    const provider = await createLLMProvider();
    const systemPrompt = buildExplainSystemPrompt(databaseType, schemaContext);

    const userMessage = `Analyze this SQL query and its EXPLAIN plan:

**Original Query:**
\`\`\`sql
${query}
\`\`\`

**EXPLAIN Plan:**
\`\`\`json
${JSON.stringify(explainPlan, null, 2)}
\`\`\`

Provide a plain-language explanation, identify performance issues, give specific recommendations, and suggest an optimized query if possible.`;

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
    return createErrorResponse(error, { route: 'api/ai/explain' });
  }
}
