/**
 * Specify 7 Query Builder support.
 *
 * Generates the correct TableList and StringId format that Specify's query
 * engine expects, following the same algorithm as the frontend's
 * QueryFieldSpec.makeTableList() in fieldSpec.ts.
 *
 * Operator codes (OperStart / OperEnd):
 *  0  = Like (SQL LIKE pattern)
 *  1  = Equals (=)
 *  2  = Greater Than (>)
 *  3  = Less Than (<)
 *  4  = Greater Than or Equals (>=)
 *  5  = Less Than or Equals (<=)
 *  6  = True (IS NOT NULL / boolean true)
 *  7  = False (IS NULL / boolean false)
 *  8  = Any / Don't care (no filter — use this for display-only fields)
 *  9  = Between (uses StartValue and EndValue)
 *  10 = In (comma-separated list)
 *  11 = Contains (LIKE %value%)
 *  12 = Empty / Null
 *  15 = Starts With
 *  18 = Ends With
 *
 * SortType:
 *  0 = no sort
 *  1 = ascending
 *  2 = descending
 */
import { query, execute, queryOne, literal } from './db.js';
import { formatTable } from './utils.js';
import { apiGet } from './specify-api.js';

export const OPER = {
  LIKE: 0,
  EQUALS: 1,
  GT: 2,
  LT: 3,
  GTE: 4,
  LTE: 5,
  TRUE: 6,
  FALSE: 7,
  ANY: 8,
  BETWEEN: 9,
  IN: 10,
  CONTAINS: 11,
  EMPTY: 12,
  STARTS_WITH: 15,
  ENDS_WITH: 18,
} as const;

export type OperCode = typeof OPER[keyof typeof OPER];

/**
 * Table IDs from the Specify datamodel.
 *
 * Loaded eagerly from `context/table_ids.json` (extracted from the live
 * Specify 7 instance's datamodel.json). Falls back to a small hardcoded map
 * if the file isn't present.
 */
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

function loadTableIds(): Record<string, number> {
  try {
    return _require('../context/table_ids.json') as Record<string, number>;
  } catch {
    return {
      collectionobject: 1, locality: 2, taxon: 4, agent: 5, collectingevent: 10,
      preparation: 63, determination: 9, storage: 29, attachment: 41,
      collectionobjectattachment: 111, geologictimeperiod: 46, geography: 12,
    };
  }
}

export const TABLE_IDS: Record<string, number> = loadTableIds();

/**
 * A step in the join path.
 * `relationshipName` is the name of the relationship on the PREVIOUS table.
 * `tableId` is the ID of the destination table.
 * `tableName` is the destination table name (lowercase).
 */
export interface JoinStep {
  relationshipName: string;
  tableId: number;
  tableName: string;
}

/**
 * Describes a field to add to a query.
 * path: chain from the context table, e.g.
 *   [{ relationshipName: 'preparations', tableId: 63, tableName: 'preparation' },
 *    { relationshipName: 'preparationAttribute', tableId: 91, tableName: 'preparationattribute' }]
 * fieldName: the final field, e.g. 'text1'
 */
export interface FieldSpec {
  path: JoinStep[];
  fieldName: string;
  /** Label shown in query results */
  columnAlias?: string;
  /** Whether to display this column in results (true = show, false = filter-only) */
  isDisplay?: boolean;
  /** Sort order: 0=none, 1=asc, 2=desc */
  sortType?: number;
  /** Negate the filter condition */
  isNot?: boolean;
  /** Filter operator (default: ANY=8 for display-only fields) */
  operStart?: OperCode;
  startValue?: string;
  operEnd?: OperCode;
  endValue?: string;
}

/**
 * Build the tableList string from a join path, following Specify's algorithm:
 *   if relatedTable.name.toLowerCase() === relationship.name.toLowerCase()
 *     → just the tableId
 *   else
 *     → `${tableId}-${relationshipName}`
 */
export function makeTableList(contextTableId: number, path: JoinStep[]): string {
  const parts = [contextTableId.toString()];
  for (const step of path) {
    const tableNameLower = step.tableName.toLowerCase();
    const relNameLower = step.relationshipName.toLowerCase();
    parts.push(tableNameLower === relNameLower
      ? step.tableId.toString()
      : `${step.tableId}-${step.relationshipName}`
    );
  }
  return parts.join(',');
}

/**
 * Build the stringId: `${tableList}.${finalTableName}.${fieldName}`
 */
export function makeStringId(contextTableId: number, path: JoinStep[], fieldName: string): string {
  const tableList = makeTableList(contextTableId, path);
  const finalTable = path.at(-1)?.tableName ?? 'collectionobject';
  return `${tableList}.${finalTable}.${fieldName}`;
}

// ─── Query CRUD ───────────────────────────────────────────────────────────

export interface QueryInfo {
  id: number;
  name: string;
  contextName: string;
  contextTableId: number;
  isFavorite: boolean;
}

export interface QueryFieldInfo {
  id: number;
  queryId: number;
  fieldName: string;
  tableList: string;
  stringId: string;
  columnAlias: string | null;
  isDisplay: boolean;
  sortType: number;
  isNot: boolean;
  operStart: number;
  startValue: string;
  position: number;
}

export async function listQueries(): Promise<QueryInfo[]> {
  const result = await query(
    `SELECT SpQueryID, Name, ContextName, ContextTableId, IsFavorite
     FROM spquery ORDER BY Name`
  );
  return result.rows.map(r => ({
    id: parseInt(r.SpQueryID!),
    name: r.Name!,
    contextName: r.ContextName!,
    contextTableId: parseInt(r.ContextTableId!),
    isFavorite: r.IsFavorite === '1',
  }));
}

export async function getQueryFields(queryId: number): Promise<QueryFieldInfo[]> {
  const result = await query(
    `SELECT SpQueryFieldID, SpQueryID, FieldName, TableList, StringId,
            ColumnAlias, IsDisplay, SortType, IsNot, OperStart, StartValue, Position
     FROM spqueryfield
     WHERE SpQueryID = ${queryId}
     ORDER BY Position`
  );
  return result.rows.map(r => ({
    id: parseInt(r.SpQueryFieldID!),
    queryId: parseInt(r.SpQueryID!),
    fieldName: r.FieldName!,
    tableList: r.TableList!,
    stringId: r.StringId!,
    columnAlias: r.ColumnAlias,
    isDisplay: r.IsDisplay === '1',
    sortType: parseInt(r.SortType ?? '0'),
    isNot: r.IsNot === '1',
    operStart: parseInt(r.OperStart ?? '8'),
    startValue: r.StartValue ?? '',
    position: parseInt(r.Position!),
  }));
}

export async function createQuery(
  name: string,
  contextTableId: number,
  contextName: string,
  specifyUserId: number,
  fields: FieldSpec[],
): Promise<number> {
  // Insert the query
  await execute(
    `INSERT INTO spquery (TimestampCreated, TimestampModified, version, ContextName, ContextTableId,
                          CountOnly, IsFavorite, Name, SelectDistinct, Smushed, SearchSynonymy,
                          FormatAuditRecIds, SqlStr, SpecifyUserID)
     VALUES (NOW(), NOW(), 0, ${literal(contextName)}, ${contextTableId},
             0, 0, ${literal(name)}, 0, 0, 0, 0, NULL, ${specifyUserId})`
  );

  const row = await queryOne('SELECT LAST_INSERT_ID() as id');
  const queryId = parseInt(row!.id!);

  // Insert the fields
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const tableList = makeTableList(contextTableId, f.path);
    const stringId = makeStringId(contextTableId, f.path, f.fieldName);
    const isDisplay = f.isDisplay !== false ? 1 : 0;
    const sortType = f.sortType ?? 0;
    const isNot = f.isNot ? 1 : 0;
    const operStart = f.operStart ?? OPER.ANY;
    const startValue = f.startValue ?? '';
    const operEnd = f.operEnd ?? null;
    const endValue = f.endValue ?? null;
    const columnAlias = f.columnAlias ? literal(f.columnAlias) : 'NULL';

    await execute(
      `INSERT INTO spqueryfield (TimestampCreated, TimestampModified, version, AllowNulls, AlwaysFilter,
                                  ColumnAlias, ContextTableIdent, EndValue, FieldName, FormatName,
                                  IsDisplay, IsNot, IsPrompt, IsRelFld, OperEnd, OperStart,
                                  Position, SortType, StartValue, StringId, TableList,
                                  SpQueryID)
       VALUES (NOW(), NOW(), 0, 1, 0,
               ${columnAlias}, NULL, ${endValue ? literal(endValue) : 'NULL'}, ${literal(f.fieldName)}, NULL,
               ${isDisplay}, ${isNot}, 0, 0, ${operEnd ?? 'NULL'}, ${operStart},
               ${i}, ${sortType}, ${literal(startValue)}, ${literal(stringId)}, ${literal(tableList)},
               ${queryId})`
    );
  }

  return queryId;
}

export async function addFieldToQuery(
  queryId: number,
  contextTableId: number,
  field: FieldSpec,
): Promise<void> {
  const existing = await queryOne(
    `SELECT MAX(Position) as maxPos FROM spqueryfield WHERE SpQueryID = ${queryId}`
  );
  const nextPos = parseInt(existing?.maxPos ?? '-1') + 1;

  const tableList = makeTableList(contextTableId, field.path);
  const stringId = makeStringId(contextTableId, field.path, field.fieldName);
  const isDisplay = field.isDisplay !== false ? 1 : 0;
  const isNot = field.isNot ? 1 : 0;
  const operStart = field.operStart ?? OPER.ANY;
  const startValue = field.startValue ?? '';
  const columnAlias = field.columnAlias ? literal(field.columnAlias) : 'NULL';

  await execute(
    `INSERT INTO spqueryfield (TimestampCreated, TimestampModified, version, AllowNulls, AlwaysFilter,
                                ColumnAlias, ContextTableIdent, EndValue, FieldName, FormatName,
                                IsDisplay, IsNot, IsPrompt, IsRelFld, OperEnd, OperStart,
                                Position, SortType, StartValue, StringId, TableList, SpQueryID)
     VALUES (NOW(), NOW(), 0, 1, 0,
             ${columnAlias}, NULL, NULL, ${literal(field.fieldName)}, NULL,
             ${isDisplay}, ${isNot}, 0, 0, NULL, ${operStart},
             ${nextPos}, ${field.sortType ?? 0}, ${literal(startValue)},
             ${literal(stringId)}, ${literal(tableList)}, ${queryId})`
  );
}

export function formatQueryForDisplay(q: QueryInfo, fields: QueryFieldInfo[]): string {
  const lines = [
    `Query #${q.id}: "${q.name}"`,
    `Context: ${q.contextName} (tableId=${q.contextTableId})`,
    '',
    'Fields:',
  ];

  for (const f of fields) {
    const display = f.isDisplay ? '✓' : '○';
    const filter = f.operStart !== 8
      ? ` [filter: op=${f.operStart} val="${f.startValue}"]`
      : '';
    const alias = f.columnAlias ? ` (alias: "${f.columnAlias}")` : '';
    lines.push(`  ${display} [${f.position}] ${f.stringId}${alias}${filter}`);
  }

  return lines.join('\n');
}

export async function runSavedQuery(queryId: number, limit: number = 50): Promise<string> {
  // Fetch display fields and their column labels from spqueryfield (ordered by Position).
  const fieldResult = await query(
    `SELECT Position, FieldName, ColumnAlias, IsDisplay, StringId
     FROM spqueryfield
     WHERE SpQueryID = ${queryId} AND IsDisplay = 1
     ORDER BY Position`
  );

  if (fieldResult.rows.length === 0) {
    return `Query #${queryId} not found or has no display fields.`;
  }

  // Build column name array: prefer ColumnAlias → FieldName.
  const columns = fieldResult.rows.map(r => r.ColumnAlias || r.FieldName || '?');

  // Execute the saved query via Specify 7 REST API.
  // The endpoint returns { results: [[val, val, ...], ...] } where each inner
  // array has values positionally aligned to the IsDisplay=1 fields.
  const path = `/stored_query/query/${queryId}/?limit=${limit}`;
  const data = await apiGet(path) as any;

  if (!data || !Array.isArray(data.results) || data.results.length === 0) {
    return 'No results found for this query.';
  }

  // Map positional arrays to named-column records and render as a TSV table.
  const rows: Record<string, string | null>[] = data.results.map((row: any[]) => {
    const record: Record<string, string | null> = {};
    columns.forEach((col, i) => {
      const val = row[i];
      record[col] = val === null || val === undefined ? null : String(val);
    });
    return record;
  });

  return formatTable(rows);
}
