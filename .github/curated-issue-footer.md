Curated for Hacktoberfest 2026. Comment to claim the issue before you start so two people do not
work on the same change. A PR must reference the issue and include tests for executable changes;
see [CONTRIBUTING.md](https://github.com/libredb/libredb-studio/blob/main/CONTRIBUTING.md).
Run `bun run test`, never bare `bun test` over a directory: the runner gives each test file its own
process, and `bun test tests/api` shares one, where a mock set up by one file leaks into the next.
The 100% line-coverage gate must stay green.

**CI is the merge gate.** If you cannot run a command locally, list that command and the reason
under a `Testing` heading in your PR body; submit the PR, and a maintainer will approve the fork's
workflow run so CI can verify it. You do not need to withdraw correct work because a local tool
is unavailable.

If your sandbox can reach the npm registry, `npm install -g bun` is another way to install Bun.
Helm is only needed to run the chart tests: without it `bun run test` leaves those files out and names them, and CI runs them.
The repository's devcontainer provides Bun and Helm and installs the JavaScript and chart dependencies automatically.
