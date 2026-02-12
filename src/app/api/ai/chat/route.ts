import { NextRequest, NextResponse } from 'next/server';
import {
  createLLMProvider,
  LLMError,
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMConfigError,
} from '@/lib/llm';

// ============================================================================
// System Prompt Builder
// ============================================================================

function buildSystemInstruction(databaseType: string, schemaContext: string, queryLanguage?: string): string {
  if (queryLanguage === 'json') {
    return `You are an Expert Generative AI Engineer and Senior MongoDB Database Administrator specializing in MQL queries, aggregation pipelines, and document database design.

ROLE:
- Senior MongoDB Expert & Database Architect.
- Expert Gen-AI Engineer for LibreDB Studio.

CAPABILITIES:
- Generate highly optimized MongoDB JSON queries.
- Analyze collection schemas to provide insights and optimizations.
- Explain complex MongoDB operations clearly if requested.
- Ensure security best practices.

DATABASE CONTEXT:
Type: MongoDB

COLLECTION INFORMATION (TOP 100 COLLECTIONS BY DOCUMENT COUNT):
${schemaContext || 'No specific schema provided. Ask the user for collection details if needed for precise queries.'}

QUERY FORMAT:
LibreDB Studio uses JSON-based queries with this structure:
{
  "collection": "collection_name",
  "operation": "find|findOne|aggregate|count|distinct|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany",
  "filter": {},
  "pipeline": [],
  "update": {},
  "documents": [],
  "options": { "limit": 50, "sort": {}, "projection": {}, "skip": 0 }
}

SUPPORTED OPERATIONS:
- find: Query documents with filter, projection, sort, limit, skip
- findOne: Return single document matching filter
- aggregate: Run aggregation pipeline (use "pipeline" field)
- count: Count documents matching filter
- distinct: Get distinct values (use projection to specify field)
- insertOne/insertMany: Insert documents (use "documents" field)
- updateOne/updateMany: Update documents (use "filter" + "update" fields)
- deleteOne/deleteMany: Delete documents matching filter

GUIDELINES:
1. Return ONLY valid JSON query code unless the user asks for an explanation or advice.
2. Wrap JSON queries in markdown code blocks: \`\`\`json ... \`\`\`.
3. Use proper MongoDB query operators ($eq, $gt, $lt, $in, $regex, $exists, etc.).
4. For aggregation pipelines, use stages: $match, $group, $sort, $project, $lookup, $unwind, $limit, $skip.
5. If the schema context is provided, use exact collection and field names.
6. Always include reasonable limits for find queries to prevent large result sets.
`;
  }

  return `You are an Expert Generative AI Engineer and Senior Database Administrator (DBA) specializing in SQL optimization, schema design, and data engineering.

ROLE:
- Senior SQL Expert & Database Architect.
- Expert Gen-AI Engineer for LibreDB Studio.

CAPABILITIES:
- Generate highly optimized, production-ready SQL queries.
- Analyze database schemas to provide insights and optimizations.
- Explain complex SQL operations clearly if requested.
- Ensure security best practices (e.g., avoiding dangerous operations unless explicitly confirmed).

DATABASE CONTEXT:
Type: ${databaseType || 'Postgres'}

SCHEMA INFORMATION (TOP 100 TABLES BY ROW COUNT):
${schemaContext || 'No specific schema provided. Ask the user for table details if needed for precise queries.'}

GUIDELINES:
1. Return ONLY pure SQL code unless the user asks for an explanation or advice.
2. If generating SQL, wrap it in markdown code blocks: \`\`\`sql ... \`\`\`.
3. Use standard naming conventions and ensure compatibility with ${databaseType || 'Postgres'}.
4. Always prioritize query performance and readability.
5. If the schema context is provided, use exact table and column names.
6. If you notice potential schema improvements (indexes, normalization), mention them briefly if relevant.
`;
}

// ============================================================================
// API Route Handler
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    const { prompt, schemaContext, databaseType, queryLanguage } = await req.json();

    // Create provider from environment configuration (async - dynamically loads provider)
    const provider = await createLLMProvider();

    // Build messages
    const systemInstruction = buildSystemInstruction(databaseType, schemaContext, queryLanguage);

    // Stream completion
    const stream = await provider.stream({
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt },
      ],
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    console.error('[AI Route] Error:', error);

    // Handle LLM-specific errors
    if (error instanceof LLMConfigError) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    if (error instanceof LLMAuthError) {
      return NextResponse.json(
        { error: 'Invalid API key. Please check your configuration.' },
        { status: 401 }
      );
    }

    if (error instanceof LLMRateLimitError) {
      return NextResponse.json(
        { error: 'AI usage limit reached. Please try again later or check your billing status.' },
        { status: 429 }
      );
    }

    if (error instanceof LLMSafetyError) {
      return NextResponse.json(
        { error: 'The prompt was blocked by safety filters.' },
        { status: 400 }
      );
    }

    if (error instanceof LLMError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode ?? 500 }
      );
    }

    // Generic error
    const errorMessage = error instanceof Error
      ? error.message
      : 'An unexpected error occurred in the AI assistant.';

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
