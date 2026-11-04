#!/usr/bin/env node
// Install the warning filter before anything loads node:sqlite (builtins load
// while static imports are linked, so the CLI itself is imported dynamically).
import './quiet.js';

await import('./cli.js');
