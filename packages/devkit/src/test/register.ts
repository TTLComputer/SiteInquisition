import { register } from 'node:module';

// Loaded with --import before a test file; the aliases come from the runner.
const aliases = JSON.parse(process.env.SIQ_TEST_ALIASES ?? '{}') as Record<string, string>;
register('./hooks.js', import.meta.url, { data: { aliases } });
