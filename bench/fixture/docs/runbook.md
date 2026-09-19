# Runbook

## Rebuilding

`npm run build` regenerates `src/generated/` and `dist/`. Both are disposable.

## local-data/

Developer scratch space. It is deliberately NOT tracked by git and is NOT
reproducible — several engineers keep captured production payloads there for
debugging. Do not delete it as part of a clean-up.
