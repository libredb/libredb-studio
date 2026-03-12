import { NextRequest, NextResponse } from 'next/server';
import { createLLMProvider } from '@/lib/llm';
import { createErrorResponse } from '@/lib/api/errors';

export async function POST(req: NextRequest) {
  try {
    const { schemaContext, databaseType, mode } = await req.json();

    if (!schemaContext) {
      return NextResponse.json({ error: 'Schema context required' }, { status: 400 });
    }

    const provider = await createLLMProvider();

    const systemPrompt = mode === 'table'
      ? `You are a database documentation expert. Given a table schema, generate clear, concise documentation.

For each table, provide:
1. **Purpose**: What this table stores and its role in the system
2. **Key Columns**: Brief description of important columns
3. **Relationships**: Detected foreign keys and relationships
4. **Usage Notes**: Common query patterns or important constraints

Format as markdown. Be concise but informative. Database type: ${databaseType || 'SQL'}.`
      : `You are a database documentation expert. Generate comprehensive database documentation.

Given the full schema, provide:
1. **Database Overview**: High-level summary of the database's purpose
2. **Entity Relationship Summary**: How tables relate to each other
3. **Table Descriptions**: Brief purpose of each table (one line each)
4. **Data Flow**: How data typically flows through the system
5. **Key Observations**: Naming conventions, patterns, potential issues

Format as clean markdown. Be concise. Database type: ${databaseType || 'SQL'}.`;

    const stream = await provider.stream({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate documentation for:\n\n${schemaContext}` },
      ],
    });

    return new Response(stream as ReadableStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    return createErrorResponse(error, { route: 'api/ai/describe-schema' });
  }
}
