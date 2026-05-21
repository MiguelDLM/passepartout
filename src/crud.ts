/**
 * Generic CRUD operations for Specify 7 Database.
 * Allows safe interaction with any table.
 */
import { query, queryOne, execute, literal } from './db.js';
import { formatTable } from './utils.js';
import { safeIdent, safeInt, safeIntList } from './sql-safety.js';
import { runPythonInWebContainer } from './executor.js';
import { apiGet, apiPut, apiPost } from './specify-api.js';
import { config } from './config.js';

/**
 * Get the Primary Key column name for a table.
 * Standard Specify convention is TableNameID (case-insensitive in MySQL, 
 * but we try to match the exact case if possible, or just use the table name + ID).
 */
// Per-table PK column cache (TTL 1h). Avoids repeating SHOW COLUMNS for every
// CRUD call. Safe even across sessions because schema rarely changes at runtime.
const pkCache = new Map<string, { col: string; expiresAt: number }>();
const PK_CACHE_TTL_MS = 60 * 60 * 1000;

export async function getPrimaryKeyColumn(tableName: string): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const key = tbl.toLowerCase();
  const cached = pkCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.col;

  const result = await query(`SHOW COLUMNS FROM ${tbl}`);
  const pkCol = result.rows.find(r => r.Key === 'PRI');
  const resolved = (pkCol && pkCol.Field) ? pkCol.Field : (key + 'id');
  pkCache.set(key, { col: resolved, expiresAt: Date.now() + PK_CACHE_TTL_MS });
  return resolved;
}

export async function listTableColumns(tableName: string): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const result = await query(`SHOW COLUMNS FROM ${tbl}`);
  if (result.rows.length === 0) return `Table ${tbl} not found or no columns found.`;
  return formatTable(result.rows);
}

export async function getRecord(tableName: string, id: number): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const recId = safeInt(id);
  const pkCol = safeIdent(await getPrimaryKeyColumn(tbl), 'primary key column');
  const result = await queryOne(`SELECT * FROM ${tbl} WHERE ${pkCol} = ${recId}`);

  if (!result) return `Record with ${pkCol}=${recId} not found in table ${tbl}.`;

  return Object.entries(result)
    .filter(([_, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/**
 * Filter value accepted by searchRecords.
 *
 *  - String shorthand:    "foo" → field = 'foo'; "%foo%" → field LIKE '%foo%'
 *  - Operator object:     { "op": "GT", "value": "2024-01-01" }
 *
 * Supported ops: EQ, NE, GT, GTE, LT, LTE, LIKE, IN, BETWEEN, IS_NULL, IS_NOT_NULL.
 * IN takes an array of strings. BETWEEN takes [low, high].
 */
type SearchFilterValue = string | number | boolean | { op: string; value?: any; high?: any; low?: any };

/**
 * Format a single value for SQL. Booleans → `1`/`0` (so BIT(1) columns like
 * IsCurrent compare correctly); numbers → bare; everything else → quoted
 * via `literal()`. The bit-field handling is essential: MariaDB's BIT(1)
 * does NOT match the string `'true'`, only the numeric 1.
 */
function sqlValue(v: any): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return literal(String(v));
}

function buildCondition(col: string, raw: SearchFilterValue): string {
  if (typeof raw === 'string') {
    return raw.includes('%') ? `${col} LIKE ${literal(raw)}` : `${col} = ${literal(raw)}`;
  }
  if (typeof raw === 'boolean') {
    return `${col} = ${raw ? 1 : 0}`;
  }
  if (typeof raw === 'number') {
    return `${col} = ${raw}`;
  }
  const op = String(raw.op || '').toUpperCase();
  switch (op) {
    case 'EQ': return `${col} = ${sqlValue(raw.value)}`;
    case 'NE': return `${col} <> ${sqlValue(raw.value)}`;
    case 'GT': return `${col} > ${sqlValue(raw.value)}`;
    case 'GTE': return `${col} >= ${sqlValue(raw.value)}`;
    case 'LT': return `${col} < ${sqlValue(raw.value)}`;
    case 'LTE': return `${col} <= ${sqlValue(raw.value)}`;
    case 'LIKE': return `${col} LIKE ${literal(String(raw.value))}`;
    case 'IN': {
      if (!Array.isArray(raw.value) || raw.value.length === 0) throw new Error(`IN value for ${col} must be a non-empty array.`);
      return `${col} IN (${raw.value.map(sqlValue).join(', ')})`;
    }
    case 'BETWEEN': {
      if (raw.low === undefined || raw.high === undefined) throw new Error(`BETWEEN on ${col} requires { low, high }.`);
      return `${col} BETWEEN ${sqlValue(raw.low)} AND ${sqlValue(raw.high)}`;
    }
    case 'IS_NULL': return `${col} IS NULL`;
    case 'IS_NOT_NULL': return `${col} IS NOT NULL`;
    default: throw new Error(`Unsupported operator "${raw.op}" on ${col}.`);
  }
}

/**
 * Curated default column sets for the most common Specify tables.
 *
 * When the caller doesn't pass `fields`, returning every column is wasteful:
 * `taxon` is 50+ columns, `collectionobject` is 70+. The LLM rarely needs
 * more than a handful. We default to a compact projection per table and the
 * caller can opt in to full columns with `fields=["*"]` or by listing them.
 */
const DEFAULT_FIELDS: Record<string, string[]> = {
  taxon:             ['TaxonID', 'FullName', 'Name', 'RankID', 'ParentID', 'IsAccepted'],
  collectionobject:  ['CollectionObjectID', 'CatalogNumber', 'AltCatalogNumber', 'CollectionID', 'CollectingEventID', 'CatalogedDate'],
  determination:     ['DeterminationID', 'CollectionObjectID', 'TaxonID', 'IsCurrent', 'DeterminedDate'],
  locality:          ['LocalityID', 'LocalityName', 'Latitude1', 'Longitude1', 'GeographyID'],
  geography:         ['GeographyID', 'Name', 'FullName', 'RankID', 'ParentID'],
  agent:             ['AgentID', 'AgentType', 'FirstName', 'LastName', 'Email'],
  attachment:        ['AttachmentID', 'OrigFilename', 'Title', 'MimeType', 'AttachmentLocation'],
  preparation:       ['PreparationID', 'CollectionObjectID', 'PrepTypeID', 'CountAmt'],
  collectingevent:   ['CollectingEventID', 'StartDate', 'EndDate', 'LocalityID', 'StationFieldNumber'],
  geologictimeperiod:['GeologicTimePeriodID', 'Name', 'FullName', 'RankID', 'StartPeriod', 'EndPeriod'],
  lithostrat:        ['LithoStratID', 'Name', 'FullName', 'RankID', 'ParentID'],
  storage:           ['StorageID', 'Name', 'FullName', 'RankID', 'ParentID'],
  referencework:     ['ReferenceWorkID', 'Title', 'WorkDate', 'DOI'],
  spauditlog:        ['SpAuditLogID', 'TableNum', 'RecordId', 'Action', 'TimestampCreated', 'CreatedByAgentID'],
};

export async function searchRecords(
  tableName: string,
  filters: Record<string, SearchFilterValue>,
  limit: number = 10,
  offset: number = 0,
  fields?: string[]
): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const safeLimit = Math.max(1, Math.min(500, safeInt(limit, 'limit')));
  const safeOffset = Math.max(0, Math.min(1_000_000, safeInt(offset, 'offset')));
  const conditions: string[] = [];

  for (const [field, value] of Object.entries(filters)) {
    const col = safeIdent(field, 'filter field');
    conditions.push(buildCondition(col, value));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Field projection:
  //   fields=undefined → use the curated default for the table (or PK only)
  //   fields=["*"]     → return every column (explicit opt-in)
  //   fields=[...]     → exactly those columns
  let selectClause: string;
  if (fields && fields.length > 0) {
    if (fields.length === 1 && fields[0] === '*') {
      selectClause = '*';
    } else {
      selectClause = fields.map(f => safeIdent(f, 'select field')).join(', ');
    }
  } else {
    const defaults = DEFAULT_FIELDS[tbl.toLowerCase()];
    if (defaults) {
      selectClause = defaults.map(f => safeIdent(f, 'select field')).join(', ');
    } else {
      // Unknown table — derive a compact projection: PK + first 4 columns.
      const pk = await getPrimaryKeyColumn(tbl);
      const colsResult = await query(`SHOW COLUMNS FROM ${tbl}`);
      const cols = colsResult.rows
        .map(r => r.Field)
        .filter((f): f is string => !!f && !/^(TimestampCreated|TimestampModified|version|CreatedByAgentID|ModifiedByAgentID|GUID)$/i.test(f));
      const chosen = [pk, ...cols.filter(c => c !== pk).slice(0, 4)];
      selectClause = chosen.map(c => safeIdent(c, 'select field')).join(', ');
    }
  }

  const sql = `SELECT ${selectClause} FROM ${tbl} ${whereClause} LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const result = await query(sql);
  if (result.rows.length === 0) return 'No records found matching the criteria.';

  return formatTable(result.rows);
}

/**
 * Create a new row via Specify's REST API.
 *
 * The API handles all the housekeeping: NodeNumber/HighestChildNodeNumber
 * for tree-shaped tables, default versions, timestamps, etc. The caller
 * passes only the user-meaningful fields.
 *
 * FK references can be provided either as numeric IDs OR full API URIs
 * ("/api/specify/taxon/261/"). Numeric IDs are auto-converted to URIs for
 * the keys listed in `auto_uri_fields` (defaults: parent, definition,
 * definitionitem, accepted, division, discipline, collection).
 *
 * Example for a new Order under Mammalia:
 *   {
 *     "table_name": "taxon",
 *     "data": {
 *       "name": "Sparassodonta",
 *       "parent": 260,
 *       "definition": 1,
 *       "definitionitem": 5
 *     }
 *   }
 */
export async function createRecord(
  tableName: string,
  data: Record<string, any>,
  extraUriFields: string[] = [],
): Promise<any> {
  const tbl = safeIdent(tableName, 'table name').toLowerCase();

  // Default fields whose numeric ID we should auto-convert to a URI.
  const defaultUriFields: Record<string, string> = {
    parent: tbl,
    definition: `${tbl}treedef`,
    definitionitem: `${tbl}treedefitem`,
    accepted: tbl,
    acceptedtaxon: 'taxon',
    division: 'division',
    discipline: 'discipline',
    collection: 'collection',
    institution: 'institution',
    referencework: 'referencework',
    journal: 'journal',
    geography: 'geography',
    locality: 'locality',
    taxon: 'taxon',
    collectingevent: 'collectingevent',
    collectionobject: 'collectionobject',
  };

  const payload: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    const targetTable = defaultUriFields[k.toLowerCase()] ?? (extraUriFields.includes(k) ? tbl : null);
    if (targetTable && typeof v === 'number') {
      // Convert numeric ID to URI
      payload[k] = `/api/specify/${targetTable}/${v}/`;
    } else if (typeof v === 'string' && /^\d+$/.test(v) && targetTable) {
      payload[k] = `/api/specify/${targetTable}/${v}/`;
    } else {
      payload[k] = v;
    }
  }

  try {
    const created = await apiPost(`/api/specify/${tbl}/`, payload);
    return created;
  } catch (err: any) {
    throw new Error(`Failed to create ${tbl}: ${err.message}`);
  }
}

export async function updateRecord(
  tableName: string,
  id: number,
  updates: Record<string, string | number | null>,
  expectedVersion?: number
): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const recId = safeInt(id);

  // 1. Fetch current record from API to get the version
  let currentRecord: any;
  try {
    currentRecord = await apiGet(`/api/specify/${tbl}/${recId}/`);
  } catch (err: any) {
    if (err.message.includes('404')) {
      throw new Error(`Record with ID=${recId} not found in table ${tbl}.`);
    }
    throw new Error(`Failed to fetch record from API: ${err.message}`);
  }

  const currentVersion = currentRecord.version;

  if (expectedVersion !== undefined && currentVersion !== undefined && currentVersion !== expectedVersion) {
    throw new Error(
      `Version conflict on ${tbl}#${recId}: expected ${expectedVersion}, found ${currentVersion}. ` +
      `Re-read the record and retry.`
    );
  }

  // 2. Prepare payload (API allows partial updates via PUT)
  const payload = {
    ...updates,
    version: currentVersion
  };

  // 3. Send PUT request
  try {
    await apiPut(`/api/specify/${tbl}/${recId}/`, payload);
  } catch (err: any) {
    if (err.message.includes('409') || err.message.includes('400')) {
      throw new Error(`Update on ${tbl}#${recId} failed (HTTP ${err.message.match(/HTTP (\d+)/)?.[1] || 'Error'}). Likely a validation issue or concurrent write changed the version. Details: ${err.message}`);
    }
    throw new Error(`Failed to update record via API: ${err.message}`);
  }

  return `Successfully updated record ${recId} in ${tbl} via REST API.`;
}

export async function batchUpdateRecords(
  tableName: string,
  ids: number[],
  updates: Record<string, string | number | null>
): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const idList = safeIntList(ids, 'ids', 500);
  const pkCol = safeIdent(await getPrimaryKeyColumn(tbl), 'primary key column');

  let setClauses: string[] = [];
  for (const [field, value] of Object.entries(updates)) {
    const col = safeIdent(field, 'update field');
    if (value === null) {
      setClauses.push(`${col} = NULL`);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for ${col}.`);
      setClauses.push(`${col} = ${value}`);
    } else {
      setClauses.push(`${col} = ${literal(String(value))}`);
    }
  }

  const columns = await query(`SHOW COLUMNS FROM ${tbl}`);
  const hasTimestamp = columns.rows.some(r => r.Field?.toLowerCase() === 'timestampmodified');
  const hasVersion = columns.rows.some(r => r.Field?.toLowerCase() === 'version');

  if (hasTimestamp) setClauses.push(`TimestampModified = NOW()`);
  if (hasVersion) setClauses.push(`version = version + 1`);

  if (setClauses.length === 0) return 'No updates provided.';

  // Run inside a single transaction so partial failures don't leave the table in a mixed state.
  await execute('START TRANSACTION');
  try {
    const sql = `UPDATE ${tbl} SET ${setClauses.join(', ')} WHERE ${pkCol} IN (${idList})`;
    const rowsAffected = await execute(sql);
    await execute('COMMIT');
    return `Successfully updated ${rowsAffected} record(s) in ${tbl}.`;
  } catch (err) {
    await execute('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function listRelatedRecords(
  parentTable: string,
  parentId: number,
  relatedTable: string,
  foreignKeyColumn?: string
): Promise<string> {
  const parent = safeIdent(parentTable, 'parent table');
  const related = safeIdent(relatedTable, 'related table');
  const pid = safeInt(parentId);
  const parentPkCol = await getPrimaryKeyColumn(parent);
  const fkCol = safeIdent(foreignKeyColumn || parentPkCol, 'foreign key column');

  const sql = `SELECT * FROM ${related} WHERE ${fkCol} = ${pid} LIMIT 50`;
  const result = await query(sql);

  if (result.rows.length === 0) {
    return `No related records found in ${related} where ${fkCol}=${pid}.`;
  }

  return formatTable(result.rows);
}

/**
 * Delete a record. Goes through the Django ORM in the web container so that
 * Specify's audit triggers (spauditlog) fire normally — this preserves the
 * standard audit trail Specify users expect.
 *
 * Requires an explicit `confirm` token matching `delete-<table>-<id>` to make
 * destructive intent unambiguous when called by an LLM client.
 */
export async function deleteRecord(tableName: string, id: number, confirm?: string): Promise<string> {
  const tbl = safeIdent(tableName, 'table name');
  const recId = safeInt(id);
  const expectedToken = `delete-${tbl}-${recId}`;

  if (confirm !== expectedToken) {
    return (
      `Refusing to delete: confirmation token required. ` +
      `Re-call with confirm="${expectedToken}" to proceed.`
    );
  }

  const pkCol = safeIdent(await getPrimaryKeyColumn(tbl), 'primary key column');
  const existing = await queryOne(`SELECT ${pkCol} FROM ${tbl} WHERE ${pkCol} = ${recId}`);
  if (!existing) throw new Error(`Record with ${pkCol}=${recId} not found in table ${tbl}.`);

  // Use the ORM so that spauditlog and related signals are fired.
  const script = `
import json
from django.apps import apps
from django.db import transaction, IntegrityError

try:
    Model = None
    for m in apps.get_models():
        if m._meta.db_table.lower() == ${JSON.stringify(tbl.toLowerCase())}:
            Model = m
            break
    if Model is None:
        print(json.dumps({"error": "Model for table '${tbl}' not found in Django apps."}))
    else:
        with transaction.atomic():
            obj = Model.objects.get(pk=${recId})
            obj.delete()
            print(json.dumps({"success": True, "deleted": 1}))
except IntegrityError as e:
    print(json.dumps({"error": "ProtectedError: " + str(e)}))
except Exception as e:
    import traceback
    print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
`.trim();

  const { stdout, stderr } = await runPythonInWebContainer(script);
  const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'));
  if (lines.length === 0) throw new Error(`Failed to delete record. Output: ${stdout} ${stderr}`);
  const result = JSON.parse(lines[lines.length - 1]);
  if (result.error) {
    if (String(result.error).toLowerCase().includes('foreign key') || String(result.error).toLowerCase().includes('protectederror')) {
      throw new Error(
        `Cannot delete ${tbl}#${recId}: referenced by other records (FK constraint). ` +
        `Delete or reassign child records first.`
      );
    }
    throw new Error(result.error);
  }
  return (
    `Successfully deleted ${tbl}#${recId} (via Django ORM). ` +
    `Note: Specify's spauditlog middleware only fires for HTTP API requests, not direct ORM deletes — ` +
    `the row is gone but no audit-log entry was created. Recover from MariaDB binlog or backup if needed.`
  );
}

export async function upsertRecordAttribute(
  parentTableName: string,
  parentId: number,
  attributeRelationName: string,
  updates: Record<string, any>,
  collectionMemberId?: number
): Promise<any> {
  const tbl = safeIdent(parentTableName, 'parent table name');
  const recId = safeInt(parentId);
  const relName = safeIdent(attributeRelationName, 'relation name');

  // 1. Fetch parent record from the API
  let parentRecord: any;
  try {
    parentRecord = await apiGet(`/api/specify/${tbl}/${recId}/`);
  } catch (err: any) {
    if (err.message.includes('404')) {
      throw new Error(`Parent record with ID=${recId} not found in table ${tbl}.`);
    }
    throw new Error(`Failed to fetch parent record from API: ${err.message}`);
  }

  // Determine collectionmemberid to use
  let resolvedCollMemberId = collectionMemberId;
  if (!resolvedCollMemberId) {
    if (parentRecord.collectionmemberid !== undefined && parentRecord.collectionmemberid !== null) {
      resolvedCollMemberId = typeof parentRecord.collectionmemberid === 'number'
        ? parentRecord.collectionmemberid
        : parseInt(String(parentRecord.collectionmemberid).split('/').filter(Boolean).pop() ?? '0');
    } else if (parentRecord.collectionmember !== undefined && parentRecord.collectionmember !== null) {
      resolvedCollMemberId = typeof parentRecord.collectionmember === 'number'
        ? parentRecord.collectionmember
        : parseInt(String(parentRecord.collectionmember).split('/').filter(Boolean).pop() ?? '0');
    } else if (parentRecord.collection !== undefined && parentRecord.collection !== null) {
      resolvedCollMemberId = typeof parentRecord.collection === 'number'
        ? parentRecord.collection
        : parseInt(String(parentRecord.collection).split('/').filter(Boolean).pop() ?? '0');
    }
  }

  // Fallback to active session collectionId if still not resolved or invalid
  if (!resolvedCollMemberId || isNaN(resolvedCollMemberId)) {
    resolvedCollMemberId = config.specify.collectionId;
  }

  // 2. Prepare the nested attribute object
  let attrObj = parentRecord[relName];
  if (!attrObj) {
    // If the attribute relation does not exist, create it new
    attrObj = {
      collectionmemberid: resolvedCollMemberId,
      ...updates
    };
  } else {
    // If it exists, merge the updates, retaining its id and version
    attrObj = {
      ...attrObj,
      collectionmemberid: resolvedCollMemberId,
      ...updates
    };
  }

  // 3. Prepare the PUT payload.
  const payload = {
    ...parentRecord,
    [relName]: attrObj
  };

  // 4. Send PUT request
  try {
    const updated = await apiPut(`/api/specify/${tbl}/${recId}/`, payload);
    return updated;
  } catch (err: any) {
    throw new Error(`Failed to upsert nested attribute ${relName} on ${tbl}#${recId}: ${err.message}`);
  }
}
