#!/usr/bin/env node
// Compatibility shim: the CLI is now `duto`. This keeps `otw` and `node bin/otw.mjs` working.
await import('./duto.mjs')
