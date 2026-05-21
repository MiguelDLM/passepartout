/**
 * SQL identifier safety helpers.
 *
 * `literal()` in db.ts escapes VALUES; this module guards IDENTIFIERS
 * (table names, column names, relationship names) that get interpolated
 * directly into SQL strings.
 *
 * Why: a MCP tool argument like `table_name: "taxon; DROP TABLE x; --"`
 * would otherwise reach the database verbatim.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function safeIdent(name: string, role = 'identifier'): string {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(
      `Invalid SQL ${role}: ${JSON.stringify(name)}. ` +
      `Allowed: 1-64 chars, [A-Za-z_][A-Za-z0-9_]*`
    );
  }
  return name;
}

/**
 * Validate a positive integer (for IDs that get interpolated into SQL or
 * into Python source executed in the web container).
 */
export function safeInt(value: unknown, role = 'id'): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${role}: ${JSON.stringify(value)}. Must be a non-negative integer.`);
  }
  return n;
}

/** Validate an array of integer IDs and produce a safe comma-separated list. */
export function safeIntList(values: unknown, role = 'id list', maxLen = 500): string {
  if (!Array.isArray(values)) throw new Error(`Invalid ${role}: expected array.`);
  if (values.length === 0) throw new Error(`Empty ${role}.`);
  if (values.length > maxLen) throw new Error(`${role} exceeds maximum length of ${maxLen}.`);
  return values.map(v => safeInt(v, role)).join(',');
}

/**
 * Validate that a SQL statement is strictly read-only.
 * Only allows SELECT, SHOW, DESCRIBE, and EXPLAIN, and blocks write/mutation keywords.
 */
export function validateReadOnlySql(sql: string): void {
  if (typeof sql !== 'string') {
    throw new Error('SQL query must be a string.');
  }

  // Remove multi-line comments: /* ... */
  // Remove single-line comments: -- ... or # ...
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--|#)[^\r\n]*/g, ' ')
    .trim();

  if (!cleaned) {
    throw new Error('SQL query is empty.');
  }

  // Must start with SELECT, SHOW, DESCRIBE, or EXPLAIN (allowing optional leading spaces/parentheses)
  const firstWordMatch = cleaned.match(/^\s*\(?\s*([A-Za-z]+)/);
  if (!firstWordMatch) {
    throw new Error('Could not identify the SQL command/keyword.');
  }

  const firstKeyword = firstWordMatch[1].toUpperCase();
  const allowedFirstKeywords = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'];
  if (!allowedFirstKeywords.includes(firstKeyword)) {
    throw new Error(`Forbidden SQL command: "${firstKeyword}". Only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed.`);
  }

  const forbiddenKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
    'REPLACE', 'RENAME', 'GRANT', 'REVOKE', 'MERGE', 'CALL', 'LOAD', 'INTO',
    'OUTFILE', 'DUMPFILE'
  ];

  for (const keyword of forbiddenKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(cleaned)) {
      throw new Error(`Forbidden SQL keyword detected: "${keyword}". Direct SQL queries must be strictly read-only.`);
    }
  }
}

