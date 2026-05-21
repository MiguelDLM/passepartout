/**
 * Schema and Metadata exploration for Specify 7.
 * Reads the Specify Data Model configuration to provide labels and field info.
 */
import { query, literal } from './db.js';
import { formatTable } from './utils.js';
import { safeIdent } from './sql-safety.js';

export interface TableMetadata {
  tableId: number;
  tableName: string;
  className: string;
}

/**
 * List Specify tables. Without `pattern`, returns all ~250 names — that's
 * expensive in tokens. Pass a SQL LIKE pattern like `"taxon%"` to scope.
 */
export async function listAllTables(pattern?: string): Promise<string> {
  const sql = pattern ? `SHOW TABLES LIKE ${literal(pattern)}` : 'SHOW TABLES';
  const result = await query(sql);
  return formatTable(result.rows);
}

/**
 * Describe table fields. By default returns only "real" columns — i.e.
 * fields with a concrete Java type (java.lang.String, etc.) — skipping
 * Specify's denormalized rank-cache columns (kingdomAuthor, classCommonName,
 * familyGUID, …) and the relationship pseudo-fields ("acceptedTaxon",
 * "children", …). Those bloat the response from ~10 rows to 80+.
 *
 * Pass include_relationships=true to also list relationships (ManyToOne /
 * OneToMany etc.). Pass include_cached_ranks=true to include the rank-cache
 * derived columns.
 */
export async function getTableFieldMetadata(
  tableName: string,
  includeRelationships: boolean = false,
  includeCachedRanks: boolean = false,
): Promise<string> {
  const tbl = safeIdent(tableName, 'table name').toLowerCase();

  // Build the type filter:
  //   include_relationships=false  → exclude NULL/empty types (those are relationships)
  //   include_cached_ranks=false   → exclude the rank-derived columns (kingdomAuthor, classGUID, …)
  const rankCacheRegex = '^(kingdom|subkingdom|phylum|subphylum|superclass|class|subclass|infraclass|cohort|superorder|order|suborder|infraorder|parvorder|superfamily|family|subfamily|tribe|subtribe|genus|subgenus|species|subspecies|division|subdivision|section|subsection|component)(author|commonname|guid|source)?$';
  const typeFilter = includeRelationships ? '' : 'AND sci.Type IS NOT NULL AND sci.Type <> \'\'';
  const cachedFilter = includeCachedRanks ? '' : `AND sci.Name NOT REGEXP ${literal(rankCacheRegex)}`;

  const sql = `
    SELECT
      sci.Name AS FieldName,
      MAX(COALESCE(s.Text, '')) AS Label,
      MAX(COALESCE(sci.Type, '')) AS Type,
      MAX(COALESCE(sci.IsRequired, 0)) AS IsReq
    FROM splocalecontaineritem sci
    JOIN splocalecontainer sc ON sci.SpLocaleContainerID = sc.SpLocaleContainerID
    LEFT JOIN splocaleitemstr s ON s.SpLocaleContainerItemNameID = sci.SpLocaleContainerItemID AND s.Language = 'en'
    WHERE sc.Name = ${literal(tbl)}
      AND (sci.IsHidden = 0 OR sci.IsHidden IS NULL)
      AND sci.Name NOT REGEXP '^(text|integer|number|yesno|remarks)[0-9]+$'
      AND sci.Name NOT REGEXP '^[a-z]+[0-9]+$'
      ${typeFilter}
      ${cachedFilter}
    GROUP BY sci.Name
    ORDER BY sci.Name
  `;

  const result = await query(sql);
  if (result.rows.length === 0) {
    return `No metadata found for table ${tbl} in splocalecontainer. This usually means it uses system defaults or all fields are hidden.`;
  }

  return formatTable(result.rows);
}

export async function getRelationships(tableName: string): Promise<string> {
  const tbl = safeIdent(tableName, 'table name').toLowerCase();
  const sql = `
    SELECT
      COLUMN_NAME as 'Field',
      REFERENCED_TABLE_NAME as 'Related Table',
      REFERENCED_COLUMN_NAME as 'Related Field'
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = ${literal(tbl)}
      AND TABLE_SCHEMA = DATABASE()
      AND REFERENCED_TABLE_NAME IS NOT NULL
  `;

  const result = await query(sql);
  if (result.rows.length === 0) return `No explicit foreign key relationships found for ${tbl}.`;

  return formatTable(result.rows);
}

export async function getCustomFields(tableName: string): Promise<any[]> {
  const tbl = safeIdent(tableName, 'table name').toLowerCase();
  const sql = `
    SELECT
      sci.Name AS FieldName,
      MAX(COALESCE(s.Text, '')) AS Label,
      MAX(COALESCE(sci.Type, '')) AS Type,
      MAX(COALESCE(sci.IsRequired, 0)) AS IsReq
    FROM splocalecontaineritem sci
    JOIN splocalecontainer sc ON sci.SpLocaleContainerID = sc.SpLocaleContainerID
    LEFT JOIN splocaleitemstr s ON s.SpLocaleContainerItemNameID = sci.SpLocaleContainerItemID AND s.Language = 'en'
    WHERE sc.Name = ${literal(tbl)}
      AND (sci.IsHidden = 0 OR sci.IsHidden IS NULL)
      AND (sci.Name REGEXP '^(text|integer|number|yesno|remarks)[0-9]+$' OR sci.Name REGEXP '^[a-z]+[0-9]+$')
    GROUP BY sci.Name
    ORDER BY sci.Name
  `;

  const result = await query(sql);
  return result.rows;
}

