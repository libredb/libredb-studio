# Release V0.3.0 - Modern SQL Console & Database Maintenance

## Improvements

### 1. Modern SQL Query Console
- **Run Selected:** Added the ability to execute only the selected text in the Monaco Editor.
- **Smart Statement Detection:** If no text is selected, the editor automatically detects and executes the SQL statement under the cursor (delimited by semicolons).
- **Visual Feedback:** Executed statements are briefly highlighted in the editor for clear feedback.
- **Keyboard Shortcuts:** Added `Ctrl+Enter` to run queries and `Alt+Shift+F` for formatting.
- **Context Menu:** Integrated SQL actions into the editor's right-click menu.

### 2. Advanced SQL Formatting
- **Tabular Layout:** Improved SQL formatting with a professional tabular layout for better readability.
- **Keyword Standardizing:** Automatic conversion of keywords and data types to uppercase.
- **Improved Logic Layout:** Logical operators (AND, OR) are now placed at the start of lines for clearer complex queries.

### 3. Database Exploration & Maintenance
- **Schema Exploration:** Enhanced tools for exploring database tables, columns, and relationships.
- **Maintenance Tasks:** Added initial support for database maintenance operations via backend API.

---
Date: 2025-12-23