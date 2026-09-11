# Community moderation triage proof of concept

This is intentionally a conservative first step for helping maintainers identify suspicious community activity without automatically taking action against users.

## What it does

The workflow evaluates a small set of metadata signals for new or edited issues, pull requests, and comments. If the combined score reaches the configured threshold, it adds the `needs-human-review` label to the related issue or pull request.

The current signals are deliberately simple and explainable:

- very new or new GitHub account;
- no repository association or first-time contributor status;
- unusually many external links;
- unusually many user mentions.

These signals are not treated as proof of abuse. They only determine whether a maintainer should review the activity.

## What it does not do

The workflow does not:

- block or ban users;
- close issues or pull requests;
- delete or hide comments;
- post public accusations;
- check out or execute code from pull requests;
- use repository secrets.

A maintainer always makes the final moderation decision.

## Security model

`pull_request_target` is used only so metadata-only triage can label pull requests from forks. The workflow never checks out the pull request head or executes contributor-controlled code.

Permissions are limited to:

- `contents: read`;
- `issues: write`;
- `pull-requests: write`.

The workflow does not request access to repository secrets.

## Tuning

The default review threshold is `3`. Maintainers can override it with the repository variable `MODERATION_REVIEW_THRESHOLD` without editing the workflow.

The initial rollout should remain label-only. After enough real examples have been reviewed, the signals and threshold can be adjusted based on false positives and missed cases.

## Suggested rollout

1. Run in label-only mode for at least a week.
2. Review every flagged item manually.
3. Record false positives and missed bot activity.
4. Adjust weights or add repository-specific signals only when there is evidence they help.
5. Keep destructive moderation actions out of the workflow unless maintainers explicitly decide otherwise after observing the data.
