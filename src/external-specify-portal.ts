/**
 * External Specify Portal client and data validation.
 */
import axios from 'axios';
import { queryOne, literal } from './db.js';

function normalizeUrl(url: string): string {
  let cleaned = url.trim();
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'https://' + cleaned;
  }
  return cleaned.replace(/\/+$/, '');
}

export async function specifyPortalCollections(portalUrl: string): Promise<any> {
  const base = normalizeUrl(portalUrl);
  const { data } = await axios.get(`${base}/api/collections/`, { timeout: 15000 });
  return data;
}

export async function specifyPortalFields(portalUrl: string, collection: string): Promise<any> {
  const base = normalizeUrl(portalUrl);
  const coll = collection.trim();
  const { data } = await axios.get(`${base}/${coll}/api/fields/`, { timeout: 15000 });
  return data;
}

export async function specifyPortalSearch(
  portalUrl: string,
  collection: string,
  searchQuery?: Record<string, string>,
  q?: string,
  page?: number
): Promise<any> {
  const base = normalizeUrl(portalUrl);
  const coll = collection.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (page) params.set('page', String(page));
  else params.set('page', '1');

  if (searchQuery) {
    for (const [key, value] of Object.entries(searchQuery)) {
      params.set(key, value);
    }
  }

  const { data } = await axios.get(`${base}/${coll}/api/search/?${params.toString()}`, { timeout: 20000 });
  return data;
}

export async function specifyPortalGetRecord(
  portalUrl: string,
  collection: string,
  catalogNumber: number
): Promise<any> {
  const base = normalizeUrl(portalUrl);
  const coll = collection.trim();
  const { data } = await axios.get(`${base}/${coll}/api/record/${catalogNumber}/`, { timeout: 15000 });
  return data;
}

function compareValues(
  local: string | null | undefined,
  external: string | null | undefined,
  fieldName: string
): { local: string; external: string; match: boolean | 'FUZZY_MATCH' | 'DISCREPANCY' | 'MISSING' } {
  const locVal = (local || '').trim();
  const extVal = (external || '').trim();

  if (!locVal && !extVal) {
    return { local: 'N/A', external: 'N/A', match: true };
  }
  if (locVal && !extVal) {
    return { local: locVal, external: 'N/A', match: 'MISSING' };
  }
  if (!locVal && extVal) {
    return { local: 'N/A', external: extVal, match: 'MISSING' };
  }

  // Case-insensitive exact match
  if (locVal.toLowerCase() === extVal.toLowerCase()) {
    return { local: locVal, external: extVal, match: true };
  }

  // Fuzzy matches for Country (e.g. USA vs United States)
  if (fieldName === 'Country') {
    const locLower = locVal.toLowerCase();
    const extLower = extVal.toLowerCase();
    if (
      (locLower === 'usa' && extLower === 'united states') ||
      (locLower === 'united states' && extLower === 'usa') ||
      (locLower === 'united states of america' && extLower === 'usa') ||
      (locLower === 'usa' && extLower === 'united states of america')
    ) {
      return { local: locVal, external: extVal, match: 'FUZZY_MATCH' };
    }
  }

  // Fuzzy matches for collector names (contains or partial overlap)
  if (fieldName === 'collectors') {
    const locParts = locVal.toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const extParts = extVal.toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const intersection = locParts.filter(x => extParts.includes(x));
    if (intersection.length >= Math.min(2, locParts.length, extParts.length)) {
      return { local: locVal, external: extVal, match: 'FUZZY_MATCH' };
    }
  }

  // Fuzzy matches for coordinates
  if (fieldName === 'Latitude' || fieldName === 'Longitude') {
    const lNum = parseFloat(locVal);
    const eNum = parseFloat(extVal);
    if (!isNaN(lNum) && !isNaN(eNum)) {
      if (Math.abs(lNum - eNum) < 0.0001) {
        return { local: locVal, external: extVal, match: true };
      } else if (Math.abs(lNum - eNum) < 0.01) {
        return { local: locVal, external: extVal, match: 'FUZZY_MATCH' };
      }
    }
  }

  // Fuzzy match for dates
  if (fieldName === 'eventDate') {
    try {
      const lDate = new Date(locVal).toISOString().split('T')[0];
      const eDate = new Date(extVal).toISOString().split('T')[0];
      if (lDate === eDate) {
        return { local: locVal, external: extVal, match: true };
      }
    } catch (e) {}
  }

  return { local: locVal, external: extVal, match: 'DISCREPANCY' };
}

export async function specifyPortalValidateRecord(
  portalUrl: string,
  collection: string,
  catalogNumber: number
): Promise<any> {
  // 1. Fetch external record
  let extRecord: any = null;
  try {
    const extData = await specifyPortalGetRecord(portalUrl, collection, catalogNumber);
    if (extData && extData.records && extData.records.length > 0) {
      extRecord = extData.records[0];
    }
  } catch (err: any) {
    throw new Error(`Failed to retrieve external record for catalogNumber ${catalogNumber}: ${err.message}`);
  }

  if (!extRecord) {
    return {
      catalogNumber,
      status: 'EXTERNAL_RECORD_NOT_FOUND',
      message: `No record found with catalog number ${catalogNumber} on the external Specify portal.`
    };
  }

  // 2. Fetch local record using standard nested sets for tree joins
  const sql = `
    SELECT 
      co.CatalogNumber,
      t.Family AS Family,
      t.Genus AS Genus,
      t.Species AS Species,
      l.LocalityName AS localityName,
      l.Latitude1 AS Latitude,
      l.Longitude1 AS Longitude,
      g_country.Name AS Country,
      g_state.Name AS State,
      g_county.Name AS County,
      ce.StartDate AS eventDate,
      (SELECT GROUP_CONCAT(CONCAT(COALESCE(ag.LastName, ''), ', ', COALESCE(ag.FirstName, '')) ORDER BY c.OrderNumber SEPARATOR '; ')
       FROM collector c
       JOIN agent ag ON c.AgentID = ag.AgentID
       WHERE c.CollectingEventID = ce.CollectingEventID) AS collectors
    FROM collectionobject co
    LEFT JOIN determination d ON d.CollectionObjectID = co.CollectionObjectID AND d.IsCurrent = 1
    LEFT JOIN taxon t ON d.TaxonID = t.TaxonID
    LEFT JOIN collectingevent ce ON co.CollectingEventID = ce.CollectingEventID
    LEFT JOIN locality l ON ce.LocalityID = l.LocalityID
    LEFT JOIN geography g_loc ON l.GeographyID = g_loc.GeographyID
    LEFT JOIN geography g_country ON g_country.NodeNumber <= g_loc.NodeNumber AND g_country.HighestChildNodeNumber >= g_loc.NodeNumber AND g_country.RankID = 200 AND g_country.GeographyTreeDefID = g_loc.GeographyTreeDefID
    LEFT JOIN geography g_state ON g_state.NodeNumber <= g_loc.NodeNumber AND g_state.HighestChildNodeNumber >= g_loc.NodeNumber AND g_state.RankID = 300 AND g_state.GeographyTreeDefID = g_loc.GeographyTreeDefID
    LEFT JOIN geography g_county ON g_county.NodeNumber <= g_loc.NodeNumber AND g_county.HighestChildNodeNumber >= g_loc.NodeNumber AND g_county.RankID = 400 AND g_county.GeographyTreeDefID = g_loc.GeographyTreeDefID
    WHERE co.CatalogNumber = ${literal(String(catalogNumber))}
    LIMIT 1
  `;

  let localRecord: any = null;
  try {
    localRecord = await queryOne(sql);
  } catch (err: any) {
    throw new Error(`Failed to query local database: ${err.message}`);
  }

  if (!localRecord) {
    return {
      catalogNumber,
      status: 'LOCAL_RECORD_NOT_FOUND',
      message: `No record found with catalog number ${catalogNumber} in the local database.`
    };
  }

  // 3. Compare fields
  const comparison: Record<string, any> = {
    Family: compareValues(localRecord.Family, extRecord.Family, 'Family'),
    Genus: compareValues(localRecord.Genus, extRecord.Genus, 'Genus'),
    Species: compareValues(localRecord.Species, extRecord.Species, 'Species'),
    localityName: compareValues(localRecord.localityName, extRecord.localityName, 'localityName'),
    Latitude: compareValues(localRecord.Latitude, extRecord.latitude1, 'Latitude'),
    Longitude: compareValues(localRecord.Longitude, extRecord.longitude1, 'Longitude'),
    Country: compareValues(localRecord.Country, extRecord.Country, 'Country'),
    State: compareValues(localRecord.State, extRecord.State, 'State'),
    County: compareValues(localRecord.County, extRecord.County, 'County'),
    eventDate: compareValues(localRecord.eventDate, extRecord.startDate, 'eventDate'),
    collectors: compareValues(localRecord.collectors, extRecord.collectors, 'collectors')
  };

  // 4. Determine overall validation status
  let status = 'VALID';
  const discrepancies: string[] = [];
  const missing: string[] = [];

  for (const [key, value] of Object.entries(comparison)) {
    if (value.match === 'DISCREPANCY') {
      status = 'DISCREPANCY_FOUND';
      discrepancies.push(key);
    } else if (value.match === 'MISSING') {
      missing.push(key);
    }
  }

  if (status === 'VALID' && missing.length > 0) {
    status = 'MISSING_DATA';
  }

  return {
    catalogNumber,
    status,
    discrepancies,
    missing,
    comparison
  };
}
