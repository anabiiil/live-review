// Production warning filter. Node prints an ExperimentalWarning when node:sqlite is loaded; that one warning is
// noise for the owner, so it is dropped. Every other warning is still printed. Import this before anything that
// loads node:sqlite.
//
// Node's default warning printer is itself a 'warning' listener, so replacing it means removing all listeners
// and printing the warnings we keep ourselves.

/** @param {Error} w */
export const isSqliteExperimentalWarning = (w) => w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message);

/** @param {Error} w */
function onWarning(w) {
  if (isSqliteExperimentalWarning(w)) return;
  console.warn(`${w.name}: ${w.message}`);
}

if (!process.listeners('warning').includes(onWarning)) {
  process.removeAllListeners('warning');
  process.on('warning', onWarning);
}
