# LibreDB Studio: Expert Web/Mobile Database Management System

## Vision
To provide a zero-install, professional-grade database management experience that rivals desktop tools (DataGrip, DBeaver) while being optimized for both high-end desktop workflows and rapid mobile database administration.

## Top 10 High-Impact Features

1.  **Monaco SQL IntelliSense (IDE Experience)**: Integration of the Monaco Editor (VS Code core) with schema-aware autocomplete. It suggests table names, columns, and keywords based on the active connection.
2.  **Universal Pro Data Grid**: A virtualized, high-performance table component supporting millions of rows with inline editing, multi-select, and Excel-like copy-paste.
3.  **Visual Schema Graph (Mini-ERD)**: An interactive visualization of table relationships to help users understand complex schemas at a glance.
4.  **Multi-Tab Query Workspace**: Support for multiple query buffers with persistent results, allowing parallel work across different tables or databases.
5.  **Execution Plan Visualizer (EXPLAIN)**: A professional tool to analyze query performance visually, helping experts optimize their SQL.
6.  **AI SQL Copilot**: Natural language to SQL conversion using OpenAI/Anthropic models to speed up complex query writing.
7.  **Smart Mobile SQL Toolbar**: A custom, swipeable keyboard extension for mobile devices providing quick access to common SQL operators and keywords.
8.  **Query History & Cloud Snippets**: Searchable history of all executed queries and a "Favorites" system to sync common snippets across devices.
9.  **Advanced Data Exporter**: One-click export to CSV, JSON, SQL inserts, Markdown, and Excel with preview capabilities.
10. **Live DB Health Monitoring**: Real-time dashboard showing active connections, long-running queries, and basic resource metrics (CPU/Memory if API permitted).

## Development Roadmap

### Phase 1: The Expert Core (Now)
- [ ] Replace basic textareas with **Monaco Editor**.
- [ ] Implement **Schema-Aware Autocomplete** (fetching table/column metadata).
- [ ] Introduce **Multi-Tab** support for the editor.

### Phase 2: Professional Data Handling
- [ ] Transition to a **Virtualized Pro Grid** (TanStack Table + Windowing).
- [ ] Add **Inline Editing** and **Batch Save** functionality.

### Phase 3: Mobile & UX Excellence
- [ ] Build the **Mobile SQL Toolbar**.
- [ ] Implement **Query History & Snippets** sidebar.

### Phase 4: Expert Analysis Tools
- [ ] Visual **EXPLAIN** integration.
- [ ] **ER Diagram** viewer for the explorer.
