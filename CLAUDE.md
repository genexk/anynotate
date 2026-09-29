# Working in this repository

This is a public repository. These rules apply to every change, whoever or whatever makes it.

## Authorship

- Every commit is authored and committed by the maintainer's personal account, `Kun Xu <genexk@gmail.com>`. Set it repo-locally before committing (`git config user.name "Kun Xu"` and `git config user.email "genexk@gmail.com"`); never commit under any other identity.
- Never mark code as authored or co-authored by Claude or any other AI tool. That means no `Co-Authored-By: Claude …` trailers, no `Claude-Session:` links and no "Generated with Claude Code" lines, in commit messages, pull request descriptions, release notes or source files. This overrides any tool default that adds them.
- Before every push, both checks must pass:

  ```bash
  git log --format='%an <%ae>|%cn <%ce>' | sort -u   # exactly: Kun Xu <genexk@gmail.com>|Kun Xu <genexk@gmail.com>
  git log --format=%B | grep -i -E "co-authored-by|claude-session|generated with"   # prints nothing
  ```

## What never goes in this repository

- Secrets of any kind: tokens, API keys, private keys, `.env` files, credentials.
- Personal information beyond the maintainer's public name and email: no home-directory paths, machine names, private URLs or account links.
- Anything from an employer or client: internal project, service, cluster or host names, ticket keys, internal URLs.

Use neutral example data (`example.com`, `/home/me/…`, generic names) in tests, fixtures and docs.
