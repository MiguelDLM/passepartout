/**
 * Database connection module for Specify 7 MariaDB.
 * Supports direct connection, kubectl exec, and docker exec.
 */
import { config } from './config.js';
import { runCommandInContainer, runPythonInWebContainer } from './executor.js';
import mysql from 'mysql2/promise';
import { validateReadOnlySql } from './sql-safety.js';
import { formatTable } from './utils.js';


export interface QueryResult {
  rows: Record<string, string | null>[];
  fields: string[];
}

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0');
}

export async function query(sql: string): Promise<QueryResult> {
  if (config.mode === 'direct') {
    const [rows, fields] = await getPool().query(sql);
    return {
      rows: (rows as any[]).map(r => {
        const row: Record<string, string | null> = {};
        Object.keys(r).forEach(k => {
          row[k] = r[k] === null ? null : String(r[k]);
        });
        return row;
      }),
      fields: (fields ?? []).map(f => f.name),
    };
  } else {
    // kubectl or docker mode: use mysql client in container.
    // SQL is piped via base64+stdin so no shell-quoting hazards survive the
    // kubectl-exec → bash-c → mysql pipeline. Password goes through MYSQL_PWD
    // env to stay out of `ps`.
    const { stdout } = await runMysqlInContainer(sql);

    const lines = stdout.split('\n').filter(l => l.trim());
    if (lines.length === 0) return { rows: [], fields: [] };

    const fields = lines[0].split('\t');
    const rows = lines.slice(1).map(line => {
      const values = line.split('\t');
      const row: Record<string, string | null> = {};
      fields.forEach((f, i) => {
        row[f] = values[i] === 'NULL' ? null : (values[i] ?? null);
      });
      return row;
    });

    return { rows, fields };
  }
}

async function runMysqlInContainer(sql: string): Promise<{ stdout: string; stderr: string }> {
  const b64 = Buffer.from(sql).toString('base64');
  const pwB64 = Buffer.from(config.db.password).toString('base64');
  // The whole inner script is built so that the only data flowing through
  // shell quotes are static identifiers we control; user-supplied SQL travels
  // through stdin after base64 decoding.
  const script = [
    `set -e`,
    `export MYSQL_PWD="$(echo ${pwB64} | base64 -d)"`,
    `echo ${b64} | base64 -d | mysql -u ${shellSingleQuote(config.db.user)} ${shellSingleQuote(config.db.database)} --batch`,
  ].join('; ');
  const cmd = `bash -c ${shellSingleQuote(script)}`;
  return runCommandInContainer('mariadb', cmd);
}

function shellSingleQuote(s: string): string {
  // Wrap in single quotes; escape any embedded single quote.
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export async function queryOne(sql: string): Promise<Record<string, string | null> | null> {
  const result = await query(sql);
  return result.rows[0] ?? null;
}

export async function execute(sql: string): Promise<number> {
  if (config.mode === 'direct') {
    // mysql2's pool.execute() expects a prepared-statement (no multi-statement, no transaction verbs).
    // We use pool.query() so single-statement transaction control (START TRANSACTION/COMMIT/ROLLBACK) works.
    const [result] = await getPool().query(sql);
    return (result as any).affectedRows || 0;
  } else {
    // mysql --batch doesn't emit "rows affected" on stdout; chain SELECT ROW_COUNT()
    // and parse the trailing integer to know what was changed.
    const chained = `${sql.replace(/;\s*$/, '')};\nSELECT ROW_COUNT() AS rc;`;
    const { stdout } = await runMysqlInContainer(chained);
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    // Last numeric line is ROW_COUNT (the rc header is the prior line).
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^-?\d+$/.test(lines[i])) return parseInt(lines[i]);
    }
    return 0;
  }
}

/**
 * Update a BLOB column using Django ORM in the web container.
 * This is the reliable way to push large XML data.
 */
export async function updateBlob(table: string, idColumn: string, id: number, blobColumn: string, data: string): Promise<void> {
  const encoded = Buffer.from(data).toString('base64');

  const pythonScript = `
import base64
from django.db import connection

blob_data = base64.b64decode("${encoded}")
cursor = connection.cursor()
cursor.execute(
    "UPDATE ${table} SET ${blobColumn} = %s, TimestampModified = NOW() WHERE ${idColumn} = %s", 
    [blob_data, ${id}]
)
connection.commit()
print("updated:", cursor.rowcount)
`.trim();

  const { stdout, stderr } = await runPythonInWebContainer(pythonScript);

  if (stderr && !stderr.includes('WARNING') && stderr.includes('Traceback')) {
    throw new Error(`Failed to update blob: ${stderr}`);
  }
  
  if (!stdout.includes('updated:')) {
    throw new Error(`Failed to update blob, output: ${stdout}`);
  }
}

export function literal(value: string): string {
  return `'${escapeString(value)}'`;
}

/**
 * Validates that the query is read-only and executes it.
 * Returns the result formatted as a TSV table.
 */
export async function executeSql(sql: string): Promise<string> {
  validateReadOnlySql(sql);
  const result = await query(sql);
  return formatTable(result.rows);
}

