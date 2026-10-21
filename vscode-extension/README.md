# LibreDB Studio for VS Code

LibreDB Studio for VS Code is a pre-release that browses and queries PostgreSQL, SQL Server, MySQL and MongoDB databases from the editor.
It needs no account and no login.
It requires VS Code 1.123 or later.

![The Connections view with PostgreSQL, MySQL, SQL Server and MongoDB connections, and a MongoDB find with its rows in LibreDB Results, in a dark theme](https://raw.githubusercontent.com/libredb/libredb-studio/main/vscode-extension/media/screenshots/connections-and-results-dark.png)

![The same window in a light theme](https://raw.githubusercontent.com/libredb/libredb-studio/main/vscode-extension/media/screenshots/connections-and-results-light.png)

![Add Connection asking for the database engine](https://raw.githubusercontent.com/libredb/libredb-studio/main/vscode-extension/media/screenshots/add-connection.png)

## Getting started

1. Select the LibreDB icon in the Activity Bar.
2. In the empty **Connections** view, select **Add Connection**.
3. Choose the database engine, then paste a connection string or enter the connection details one at a time (the gear button titled SSL and optional fields opens a review of every field), test the connection and give it a name.
4. Expand the connection to its databases, schemas, tables and views, and a table to its columns.
5. Select **Select Rows** on a table or a view, or **New Query** on a connection, and run the editor's statement with **Run Query** in the editor title.
6. The results open in the **LibreDB Results** view in the Panel, with the row count and the time the statement took.

## Results

When a statement returns more rows than one page holds, the grid offers to load more, which reads the next page of the same statement.
Copying a cell, a range of cells or a row puts it on the system clipboard.
Masking is off by default, and the grid's masking switch turns it on.
Rows live only in the window's memory, so reloading the window empties the view.

## Running and cancelling

**Run Query** sends the selected text, or the statement at the cursor when nothing is selected.
There is no confirmation before a statement runs, including one that changes data.
**Cancel Query** stops a running statement on PostgreSQL, SQL Server and MySQL.
A MongoDB command cannot be cancelled once it is sent.

## Keyboard shortcut

This pre-release binds no key to **Run Query**.
To add one, put an entry like this in your `keybindings.json`:

```json
{ "key": "ctrl+alt+r", "command": "libredb.runQuery", "when": "editorTextFocus && resource in libredb.boundDocuments" }
```

The key is your choice; VS Code already binds every Enter chord in the editor, so pick another.

## Connections and secrets

Connections live in the `libredb.connections` user setting, without passwords or connection strings.
Those stay in VS Code's secret storage on each machine.
A workspace's `.vscode/settings.json` never adds a connection.
In Restricted Mode, every connection opens with external file access denied.

## Settings

- `libredb.connections`: the saved connections, written by **Add Connection** and **Remove Connection**.
- `libredb.query.rowLimit`: the number of rows each page of results holds, 500 by default, from 1 to 10000.

## Not in this pre-release

- Editing a saved connection: when a sign-in fails, LibreDB offers Enter Credentials instead.
- Exporting results.
- Cancelling a MongoDB command, and loading more rows of a MongoDB result.
- Editor bindings that survive a window reload: after a reload, **Change Connection** binds the editor again.
- Engines beyond PostgreSQL, SQL Server, MySQL and MongoDB.

## Feedback

Report a problem or ask for a feature at https://github.com/libredb/libredb-studio/issues.
