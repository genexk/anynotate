# Contributing

Issues and pull requests are welcome.

## Development

Requires [Bun](https://bun.sh) 1.3.11 or later.

```bash
bun install
bun test            # unit and integration tests
bun run typecheck
bun run build:protocol   # builds packages/protocol/dist
```

`bin/anynotate bridge` runs the bridge from source; set `ANYNOTATE_HOME` and `ANYNOTATE_PORT` to keep it away from a real install.

## Contributor License Agreement

Before your first pull request can be merged you need to sign the [CLA](./CLA.md). The CLA bot comments on your pull request with the sentence to post; signing once covers future contributions.

## Licences

Everything in this repository is AGPL-3.0-only, except `packages/protocol`, which is Apache-2.0. Contributions are accepted under the licence of the directory they touch, plus the CLA.

The Anynotate Chrome extension is developed separately and is not part of this repository.
