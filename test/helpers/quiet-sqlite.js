// Suppresses ONLY the node:sqlite ExperimentalWarning so test output stays pristine.
// Import this before anything that loads node:sqlite. Other warnings are untouched.
const original = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const name = type ?? (warning instanceof Error ? warning.name : undefined);
  const message = warning instanceof Error ? warning.message : String(warning);
  if (name === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
  return original.call(this, warning, ...args);
};
