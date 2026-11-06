# LibreDB Studio for Claude Code

This plugin connects Claude Code to a [LibreDB Studio](https://github.com/libredb/libredb-studio), the database IDE, usually one that you or your organization run.
It installs the `libredb-studio` skill, which tells Claude how to use Studio's MCP tools, and one MCP server entry, `libredb`, that points at your Studio.
Studio keeps the database credentials, runs no model for MCP, and answers only on the connections its operator opted in to MCP.
Its tools read schemas and run bounded, read-only statements.

## What you need

- A LibreDB Studio with MCP turned on, and its MCP address, which ends in `/api/mcp`.
- A token minted on that Studio's MCP settings screen.

Studio's MCP guide explains both, in [Enabling it](https://github.com/libredb/libredb-studio/blob/main/docs/MCP.md#enabling-it) and [Getting a token](https://github.com/libredb/libredb-studio/blob/main/docs/MCP.md#getting-a-token), and its [Plugin and skill](https://github.com/libredb/libredb-studio/blob/main/docs/MCP.md#plugin-and-skill) section explains how to install the plugin from a shell.

## Install

In a Claude Code session:

```text
/plugin marketplace add libredb/libredb-studio
/plugin install libredb-studio@libredb
```

Claude Code asks for your Studio's MCP address and for the token, which it masks as you type.
Give an https address unless Studio runs on the same computer, because the token travels in the header of every request.

## Where it works

Claude Code loads the plugin's MCP server; claude.ai chat ignores a server whose address comes from a plugin option, and Cowork one that references an option with no default, as every option of this plugin is, so on both the plugin gives the skill alone.

## Example prompts

Each of these works on a connection opted in to MCP that holds tables and takes statements:

- Which database connections can you read through LibreDB Studio?
- Describe the tables of the first of those connections, with their foreign keys.
- Pick the largest table on that connection and tell me what its ten most recent rows have in common.

## Privacy

This section is the plugin's privacy statement.
The plugin sends schema requests, statements and your token only to the Studio address you configure, and to no one else.
Whoever runs the Studio at that address is its operator, usually you or your organization.
That Studio runs each call and records it in its audit log, which is kept as long as its operator keeps its logs.
The answers reach Claude as part of your conversation.
LibreDB, the project, receives, keeps or shares nothing through the plugin, unless the Studio you configure is one the project runs, such as a demo, where the project is that Studio's operator.
Claude Code keeps the token in its credential store and the address in your settings.
The plugin runs no code of its own: no hook, no script and no server process.

## Support and security

Ask questions and report defects in [GitHub issues](https://github.com/libredb/libredb-studio/issues).
Report a security issue the way [SECURITY.md](https://github.com/libredb/libredb-studio/blob/main/SECURITY.md) says, not in a public issue.
The [Troubleshooting](https://github.com/libredb/libredb-studio/blob/main/docs/MCP.md#troubleshooting) section of Studio's MCP guide explains the statuses a client gets when the address, the token or the server's setup is wrong.

## License

MIT, as the repository's [LICENSE](https://github.com/libredb/libredb-studio/blob/main/LICENSE) says.
