import sql from "mssql";
import type {
  DatabaseTable,
  DatabaseColumn,
  DatabaseIndex,
  DatabaseForeignKey,
  DatabaseTableSchema,
  DatabaseQueryResult,
} from "@roubo/shared";

const pools = new Map<string, { pool: sql.ConnectionPool; lastUsed: number }>();
const IDLE_TIMEOUT_MS = 60_000;

async function getPool(connectionString: string): Promise<sql.ConnectionPool> {
  const entry = pools.get(connectionString);
  if (entry?.pool.connected) {
    entry.lastUsed = Date.now();
    return entry.pool;
  }
  if (entry) {
    await entry.pool.close().catch(() => {});
  }
  const pool = new sql.ConnectionPool(connectionString);
  await pool.connect();
  pools.set(connectionString, { pool, lastUsed: Date.now() });
  return pool;
}

export async function closeIdleConnections(): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of pools) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      await entry.pool.close().catch(() => {});
      pools.delete(key);
    }
  }
}

export async function closeAllConnections(): Promise<void> {
  for (const [key, entry] of pools) {
    await entry.pool.close().catch(() => {});
    pools.delete(key);
  }
}

function bracketEscape(name: string): string {
  return "[" + name.replace(/\]/g, "]]") + "]";
}

export async function getTables(connectionString: string): Promise<DatabaseTable[]> {
  const pool = await getPool(connectionString);
  const result = await pool.request().query(`
    SELECT
      t.TABLE_SCHEMA as [schema],
      t.TABLE_NAME as [name],
      t.TABLE_TYPE as [type],
      (
        SELECT SUM(p.[rows])
        FROM sys.partitions p
        WHERE p.object_id = OBJECT_ID(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME))
          AND p.index_id IN (0, 1)
      ) as [rowCount]
    FROM INFORMATION_SCHEMA.TABLES t
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
  `);

  return result.recordset.map((row) => ({
    schema: row.schema,
    name: row.name,
    type: row.type,
    rowCount: row.rowCount ?? undefined,
  }));
}

export async function getTableData(
  connectionString: string,
  schema: string,
  table: string,
  page: number,
  pageSize: number,
): Promise<DatabaseQueryResult> {
  const pool = await getPool(connectionString);
  const offset = (page - 1) * pageSize;

  const escapedSchema = bracketEscape(schema);
  const escapedTable = bracketEscape(table);

  const result = await pool
    .request()
    .input("offset", sql.Int, offset)
    .input("pageSize", sql.Int, pageSize).query(`
      SELECT *, COUNT(*) OVER() as __total_count
      FROM ${escapedSchema}.${escapedTable}
      ORDER BY (SELECT NULL)
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `);

  const totalRows = result.recordset.length > 0 ? (result.recordset[0].__total_count as number) : 0;

  const rows = result.recordset.map((row) => {
    const copy = { ...row } as Record<string, unknown>;
    delete copy.__total_count;
    return copy;
  });

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    columns,
    rows,
    totalRows,
    page,
    pageSize,
  };
}

export async function getTableSchema(
  connectionString: string,
  schema: string,
  table: string,
): Promise<DatabaseTableSchema> {
  const pool = await getPool(connectionString);

  const [columnResult, indexResult, fkResult] = await Promise.all([
    pool.request().input("schema", sql.NVarChar, schema).input("table", sql.NVarChar, table).query(`
        SELECT
          c.COLUMN_NAME as name,
          c.DATA_TYPE as dataType,
          c.CHARACTER_MAXIMUM_LENGTH as maxLength,
          CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END as isNullable,
          c.COLUMN_DEFAULT as defaultValue,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as isPrimaryKey,
          COLUMNPROPERTY(OBJECT_ID(@schema + '.' + @table), c.COLUMN_NAME, 'IsIdentity') as isIdentity
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
            ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA
          AND c.TABLE_NAME = pk.TABLE_NAME
          AND c.COLUMN_NAME = pk.COLUMN_NAME
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION
      `),
    pool.request().input("schema", sql.NVarChar, schema).input("table", sql.NVarChar, table).query(`
        SELECT
          i.name as name,
          COL_NAME(ic.object_id, ic.column_id) as columnName,
          i.is_unique as isUnique,
          i.is_primary_key as isPrimaryKey,
          i.type_desc as type
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.object_id = OBJECT_ID(@schema + '.' + @table)
          AND i.name IS NOT NULL
        ORDER BY i.name, ic.key_ordinal
      `),
    pool.request().input("schema", sql.NVarChar, schema).input("table", sql.NVarChar, table).query(`
        SELECT
          fk.name as name,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) as [column],
          OBJECT_NAME(fkc.referenced_object_id) as referencedTable,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) as referencedColumn
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        WHERE fk.parent_object_id = OBJECT_ID(@schema + '.' + @table)
      `),
  ]);

  const columns: DatabaseColumn[] = columnResult.recordset.map((row) => ({
    name: row.name,
    dataType: row.dataType,
    maxLength: row.maxLength,
    isNullable: !!row.isNullable,
    defaultValue: row.defaultValue,
    isPrimaryKey: !!row.isPrimaryKey,
    isIdentity: !!row.isIdentity,
  }));

  const indexMap = new Map<string, DatabaseIndex>();
  for (const row of indexResult.recordset) {
    const existing = indexMap.get(row.name);
    if (existing) {
      existing.columns.push(row.columnName);
    } else {
      indexMap.set(row.name, {
        name: row.name,
        columns: [row.columnName],
        isUnique: !!row.isUnique,
        isPrimaryKey: !!row.isPrimaryKey,
        type: row.type,
      });
    }
  }
  const indexes = Array.from(indexMap.values());

  const foreignKeys: DatabaseForeignKey[] = fkResult.recordset.map((row) => ({
    name: row.name,
    column: row.column,
    referencedTable: row.referencedTable,
    referencedColumn: row.referencedColumn,
  }));

  return { columns, indexes, foreignKeys };
}
