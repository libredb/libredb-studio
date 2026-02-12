import { NextRequest, NextResponse } from 'next/server';
import {
  createLLMProvider,
  LLMError,
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMConfigError,
} from '@/lib/llm';

function buildNL2SQLPrompt(databaseType: string, schemaContext: string, queryLanguage?: string): string {
  if (queryLanguage === 'json') {
    return `You are an NL-to-MongoDB translator. Convert natural language questions into MongoDB JSON queries for LibreDB Studio.

DATABASE: MongoDB

COLLECTIONS:
${schemaContext || 'No schema available.'}

QUERY FORMAT:
{
  "collection": "collection_name",
  "operation": "find|aggregate|count|distinct",
  "filter": {},
  "pipeline": [],
  "options": { "limit": 50, "sort": {} }
}

RULES:
1. Return ONLY a JSON code block with the query
2. Use exact collection and field names from the schema
3. Add reasonable limits (default 50)
4. For complex questions, prefer aggregate with pipeline
5. After the JSON block, add a brief one-line explanation starting with "-- "
`;
  }

  return `You are an NL-to-SQL translator. Convert natural language questions into ${databaseType || 'PostgreSQL'} SQL queries.

DATABASE TYPE: ${databaseType || 'PostgreSQL'}

SCHEMA:
${schemaContext || 'No schema available.'}

RULES:
1. Return ONLY a SQL code block with the query
2. Use exact table and column names from the schema
3. Add reasonable LIMIT (default 50) to prevent large result sets
4. Use JOINs when the question implies data from multiple tables
5. Handle aggregations (COUNT, SUM, AVG) when asked about totals or averages
6. After the SQL block, add a brief one-line explanation starting with "-- "
7. If the question is ambiguous, make your best guess and explain your interpretation
8. Use standard ${databaseType || 'PostgreSQL'} syntax
`;
}

export async function POST(req: NextRequest) {
  try {
    const { question, schemaContext, databaseType, queryLanguage, conversationHistory } = await req.json();

    if (!question) {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    const provider = await createLLMProvider();
    const systemPrompt = buildNL2SQLPrompt(databaseType, schemaContext, queryLanguage);

    // Build messages with optional conversation history for multi-turn
    const messages = [
      { role: 'system' as const, content: systemPrompt },
    ];

    // Add conversation history if provided
    if (conversationHistory?.length) {
      for (const msg of conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user' as const, content: question });

    const stream = await provider.stream({ messages });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    console.error('[AI:nl2sql] Error:', error);

    if (error instanceof LLMConfigError) return NextResponse.json({ error: error.message }, { status: 500 });
    if (error instanceof LLMAuthError) return NextResponse.json({ error: 'Invalid API key.' }, { status: 401 });
    if (error instanceof LLMRateLimitError) return NextResponse.json({ error: 'Rate limit reached.' }, { status: 429 });
    if (error instanceof LLMSafetyError) return NextResponse.json({ error: 'Blocked by safety filters.' }, { status: 400 });
    if (error instanceof LLMError) return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 });

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
