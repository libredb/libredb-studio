# AI Query Assistant Implementation Plan (2025)

This plan outlines the integration of multi-provider LLM support to provide Natural Language to SQL capabilities within LibreDB Studio.

## 1. Architecture

- **Providers**: Gemini, OpenAI, Ollama, Custom (LiteLLM, LMStudio, vLLM)
- **Pattern**: Strategy Pattern for provider abstraction
- **Backend**: Next.js API Route (`src/app/api/ai/chat/route.ts`)
- **LLM Module**: `src/lib/llm/` - Modular provider implementation
- **Frontend**:
  - Floating/Collapsible AI input in the Query Editor.
  - Streaming support for real-time response.
  - Schema-aware prompting (passing table names and columns to the model).

## 2. Security & Config

- Use `LLM_API_KEY` in `.env.local`.
- Configure provider with `LLM_PROVIDER` (gemini, openai, ollama, custom).
- Server-side processing only.
- Strict system instructions to prevent SQL injection or unrelated queries.

### Environment Variables

```env
LLM_PROVIDER=gemini          # gemini | openai | ollama | custom
LLM_API_KEY=your_api_key     # Required for gemini/openai
LLM_MODEL=gemini-2.5-flash   # Auto-defaults per provider
LLM_API_URL=                 # Required for ollama/custom
```

## 3. Implementation Status

### Phase 1: API Setup ✅
- [x] Create API route with streaming support.
- [x] Implement Strategy Pattern for multi-provider support.
- [x] Add error handling with custom error classes.
- [x] Implement retry logic with exponential backoff.

### Phase 2: UI Integration ✅
- [x] Add "AI Assistant" button to the Query Editor toolbar.
- [x] Create a "Prompt to SQL" dialog/input.
- [x] Implement "Apply" logic to insert generated SQL into the active tab.

### Phase 3: Pro Features (2025 Standard)
- [x] **Context Awareness**: Automatically include the selected table's schema in the prompt.
- [ ] **Explain Query**: AI explanation of complex SQL scripts.
- [ ] **Fix Errors**: AI-powered suggestions when a query fails.

## 4. Prompt Engineering Strategy

The AI will be instructed to:
1. Return ONLY pure SQL code unless an explanation is specifically requested.
2. Use standard SQL compatible with the connected database type (Postgres/MySQL/etc).
3. Respect the provided schema constraints.

## 5. LLM Module Structure

```
src/lib/llm/
├── index.ts              # Public exports
├── types.ts              # Interfaces, types, error classes
├── base-provider.ts      # Abstract base class
├── factory.ts            # createLLMProvider()
├── providers/
│   ├── gemini.ts         # Google Gemini
│   ├── openai.ts         # OpenAI API
│   ├── ollama.ts         # Ollama (local)
│   └── custom.ts         # LiteLLM, LMStudio, vLLM
└── utils/
    ├── config.ts         # Environment resolution
    ├── retry.ts          # Exponential backoff
    └── streaming.ts      # SSE parser
```
