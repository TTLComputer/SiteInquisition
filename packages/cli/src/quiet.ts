// Imported first by main.ts. Node 22 prints an ExperimentalWarning the first
// time node:sqlite loads; it says nothing useful to siq users, so drop just that one.
const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  if (String(warning instanceof Error ? warning.message : warning).includes('SQLite is an experimental feature')) return;
  emit(warning, ...rest);
}) as typeof process.emitWarning;
