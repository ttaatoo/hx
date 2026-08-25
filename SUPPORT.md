# Support

`hx` is experimental and support is best effort. There is no response-time
guarantee for general questions.

## Before asking

1. Read the [README](README.md), [contribution guide](CONTRIBUTING.md), and
   [provider guide](docs/direct-providers.md).
2. Run `hx --version` and record the operating system and CPU architecture.
3. For a local bug, run the narrowest test that shows it and try the fresh
   `./zig-out/bin/hx` binary.
4. If useful, run `/trace`. Review it and remove secrets, tokens, private paths,
   and source content before sharing it.

## Ask for help

- For a reproducible product bug, use the [bug report form](https://github.com/ttaatoo/hx/issues/new?template=hx-report.yml).
- For a non-sensitive question, open a GitHub issue with the expected result,
  actual result, version, platform, and reproduction steps.
- For a security issue, follow [SECURITY.md](SECURITY.md). Do not use a public
  issue for security details.

The project does not provide support for provider account decisions, provider
outages, model output, custom MCP server behavior, or private code. Contact the
relevant service owner for those issues.
