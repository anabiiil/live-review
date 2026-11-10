// Test output stays pristine: the same filter the production entry uses (src/quietSqlite.js).
// `npm test` preloads it with --import; test files may still import it explicitly (harmless).
import '../../src/quietSqlite.js';
