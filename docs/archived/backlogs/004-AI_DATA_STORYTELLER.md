# AI Data Storyteller

## Overview
Transform raw query results into meaningful narratives, insights, and executive summaries using AI. Move beyond "what" the data shows to "why it matters."

## Problem Statement
Data analysts spend significant time:
- Interpreting query results manually
- Writing reports explaining data findings
- Identifying trends and anomalies by eye
- Translating technical data into business language

Non-technical stakeholders struggle to:
- Understand raw data tables
- Identify what's important in large datasets
- Make decisions based on numbers alone

## Proposed Solution
AI-powered data interpretation that automatically generates:
- Natural language summaries
- Key insights and anomalies
- Trend analysis
- Executive-ready reports

## Features

### 1. One-Click Insights
```
┌─────────────────────────────────────────────────────────────┐
│ Results (1,247 rows)                    [✨ Tell me a story]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 📊 Data Story                                        │   │
│  │                                                      │   │
│  │ Key Findings:                                        │   │
│  │ • Sales increased 23% compared to last month        │   │
│  │ • Top performer: Electronics category (+45%)        │   │
│  │ • Warning: Returns in Clothing up 12%               │   │
│  │                                                      │   │
│  │ Anomalies Detected:                                  │   │
│  │ • Dec 15: Unusual spike in orders (Black Friday?)   │   │
│  │ • Region "West" underperforming by 2 std deviations │   │
│  │                                                      │   │
│  │ Recommendation:                                      │   │
│  │ "Investigate Clothing returns - may indicate        │   │
│  │  quality or sizing issues"                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2. Smart Question Interface
Instead of writing SQL, ask questions in natural language:
```
User: "What's interesting about this data?"
AI: "I notice three key patterns..."

User: "Why did sales drop in March?"
AI: "Looking at the data, the drop correlates with..."

User: "Summarize this for my manager"
AI: "Executive Summary: Q4 performance exceeded targets..."
```

### 3. Automatic Analysis Types

#### Statistical Summary
- Min, max, mean, median, std deviation
- Distribution analysis
- Correlation between columns

#### Trend Detection
- Time-series pattern recognition
- Seasonality identification
- Growth rate calculations

#### Anomaly Detection
- Outlier identification
- Unexpected patterns
- Missing data patterns

#### Comparative Analysis
- Group comparisons
- Period-over-period changes
- Benchmark comparisons

### 4. Report Generation
```
┌─────────────────────────────────────────────────────────────┐
│ Generate Report                                             │
├─────────────────────────────────────────────────────────────┤
│ Format:    [Executive Summary ▼]                            │
│ Audience:  [Non-Technical ▼]                                │
│ Include:   [✓] Charts  [✓] Key Metrics  [ ] Raw Data       │
│ Tone:      [Professional ▼]                                 │
│                                                             │
│                              [Generate PDF] [Copy Markdown] │
└─────────────────────────────────────────────────────────────┘
```

Report templates:
- Executive Summary (1 page, high-level)
- Detailed Analysis (comprehensive)
- Technical Report (for data teams)
- Presentation Slides (bullet points + charts)

### 5. Interactive Exploration
```
"Tell me more about the Electronics category"
     ↓
AI drills down and shows subcategory breakdown

"Compare this with last year"
     ↓
AI generates year-over-year comparison

"What should we do about this?"
     ↓
AI provides actionable recommendations
```

## Technical Considerations

### AI Integration
```typescript
interface StorytellerRequest {
  result: QueryResult;
  schemaContext: TableSchema[];
  queryContext: string;           // The SQL that generated this
  analysisType: 'summary' | 'trends' | 'anomalies' | 'full';
  audience: 'technical' | 'business' | 'executive';
  previousContext?: string;       // For follow-up questions
}

interface StorytellerResponse {
  summary: string;
  keyFindings: Finding[];
  anomalies: Anomaly[];
  recommendations: string[];
  charts: ChartSuggestion[];
  confidence: number;
}
```

### LLM Prompting Strategy
1. **Context Building**
   - Schema information (table/column names, types)
   - Query intent (what user was looking for)
   - Result statistics (row count, value ranges)

2. **Analysis Prompt**
   ```
   You are a data analyst. Given this query result:
   - Schema: [tables and columns]
   - Query: [SQL]
   - Sample data: [first 100 rows]
   - Statistics: [aggregates]

   Provide insights in this format:
   1. Key Findings (3-5 bullet points)
   2. Anomalies (if any)
   3. Trends (if time-series)
   4. Recommendations
   ```

3. **Audience Adaptation**
   - Technical: Include SQL, statistical terms
   - Business: Focus on metrics, KPIs
   - Executive: High-level, actionable

### Data Sampling for Large Results
- First 100 rows + random sample of 100
- Statistical aggregates (min, max, avg, percentiles)
- Column value distributions
- Never send full dataset to LLM

### Streaming Response
- Stream AI response for better UX
- Show "Analyzing..." with progress
- Typewriter effect for narrative

## UI Components

### New Components
- `DataStoryPanel.tsx` - Main storyteller interface
- `InsightCard.tsx` - Individual insight display
- `AnomalyBadge.tsx` - Anomaly highlight component
- `ReportGenerator.tsx` - Report export modal
- `QuestionInput.tsx` - Natural language question input

### Integration Points
- Results toolbar: "Tell me a story" button
- New bottom panel mode or floating panel
- Context menu on columns: "Analyze this column"
- Query editor: Natural language input mode

## User Flow

```
1. User runs query, sees results
   ↓
2. Clicks "✨ Tell me a story" button
   ↓
3. AI analyzes data (streaming response)
   ↓
4. Insights panel shows findings
   ↓
5. User can ask follow-up questions
   ↓
6. User exports as report (optional)
```

## Example Outputs

### For Sales Data
```
📊 Sales Analysis - December 2024

Key Findings:
• Total revenue: $1.2M (+18% vs November)
• Best day: December 15 ($89K) - likely Black Friday effect
• Top category: Electronics (42% of revenue)

⚠️ Anomalies:
• Unusually high returns in Clothing (12% vs 5% average)
• Western region 23% below other regions

📈 Trends:
• Steady growth since October (+8% MoM)
• Weekend sales 34% higher than weekdays

💡 Recommendations:
1. Investigate Clothing returns - possible sizing issue
2. Review Western region - may need marketing push
```

### For User Analytics
```
📊 User Activity Report

Key Findings:
• 15,234 active users this week (+5%)
• Average session: 12 minutes
• Most active: Tuesday 2-4 PM

⚠️ Concerns:
• 23% bounce rate on mobile (desktop: 8%)
• New user retention dropped to 34%

💡 Recommendations:
1. Prioritize mobile experience optimization
2. Review onboarding flow for new users
```

## Configuration Options
- Default analysis depth: Quick / Standard / Deep
- Preferred language style: Casual / Professional / Academic
- Auto-analyze on query: On / Off
- Include chart suggestions: On / Off

## Privacy & Security
- Data sampling (never full dataset to LLM)
- Option to disable for sensitive queries
- No PII in prompts (mask if detected)
- Local-only mode (Ollama) for sensitive data

## Acceptance Criteria
- [ ] "Tell me a story" button appears on results
- [ ] AI generates natural language summary
- [ ] Key findings are extracted and highlighted
- [ ] Anomalies are detected and flagged
- [ ] User can ask follow-up questions
- [ ] Reports can be exported as PDF/Markdown
- [ ] Analysis adapts to audience type
- [ ] Streaming response for better UX
- [ ] Works with existing LLM providers

## Dependencies
- LLM integration (existing)
- Data Visualization (for chart suggestions)
- Export functionality

## Estimated Effort
High complexity

## Priority
P1 - Core differentiator

## Related Features
- AI Query Assistant (existing)
- Data Visualization (existing)
- Query Time Machine (planned)
