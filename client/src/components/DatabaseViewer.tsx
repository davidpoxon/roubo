import { useState, useMemo } from "react";
import { Button } from "react-aria-components";
import {
  Database,
  Table2,
  Eye,
  ChevronLeft,
  ChevronRight,
  Key,
  Link2,
  Hash,
  AlertCircle,
} from "lucide-react";
import { useDbTables, useDbTableData, useDbTableSchema } from "../hooks/useDatabase";
import Spinner from "./Spinner";
import type { DatabaseTable, DatabaseColumn } from "@roubo/shared";

interface Props {
  projectId: string;
  benchId: number;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function TypeBadge({ column }: { column: DatabaseColumn }) {
  let label = column.dataType;
  if (column.maxLength !== null && column.maxLength > 0 && column.maxLength !== -1) {
    label += `(${column.maxLength})`;
  } else if (column.maxLength === -1) {
    label += "(max)";
  }

  return (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-200 dark:bg-stone-800/80 text-stone-500">
      {label}
    </span>
  );
}

function DataTab({
  projectId,
  benchId,
  schema,
  table,
}: {
  projectId: string;
  benchId: number;
  schema: string;
  table: string;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const { data, isLoading, isError } = useDbTableData(
    projectId,
    benchId,
    schema,
    table,
    page,
    pageSize,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-sm text-stone-600">
        <Spinner /> Loading data...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-stone-600">
        Failed to load table data.
      </div>
    );
  }

  if (data.rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-stone-600">No rows.</div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.totalRows / pageSize));

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              {data.columns.map((col) => (
                <th
                  key={col}
                  className="sticky top-0 bg-stone-100 dark:bg-stone-900 text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-stone-500 border-b border-stone-200 dark:border-stone-800/60 whitespace-nowrap"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr
                key={i}
                className={`${
                  i % 2 === 0 ? "bg-transparent" : "bg-stone-100/50 dark:bg-stone-900/30"
                } hover:bg-stone-200/50 dark:hover:bg-stone-800/40 transition-colors duration-100`}
              >
                {data.columns.map((col) => {
                  const val = row[col];
                  const isNull = val === null || val === undefined;
                  return (
                    <td
                      key={col}
                      className={`px-3 py-1.5 font-mono text-[12px] whitespace-nowrap border-b border-stone-200 dark:border-stone-800/20 ${
                        isNull
                          ? "text-stone-400 dark:text-stone-700 italic"
                          : "text-stone-700 dark:text-stone-300"
                      }`}
                    >
                      {formatCellValue(val)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-3 py-2.5 border-t border-stone-200 dark:border-stone-800/60 shrink-0">
        <span className="text-[11px] text-stone-500 dark:text-stone-600">
          <span className="font-mono text-stone-500">{data.totalRows.toLocaleString()}</span> rows
        </span>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {[25, 50, 100].map((size) => (
              <Button
                key={size}
                onPress={() => {
                  setPageSize(size);
                  setPage(1);
                }}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors outline-none ${
                  pageSize === size
                    ? "bg-stone-300 dark:bg-stone-700 text-stone-800 dark:text-stone-200"
                    : "text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400"
                }`}
              >
                {size}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              isDisabled={page <= 1}
              onPress={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1 rounded text-stone-500 hover:text-stone-300 disabled:opacity-30 transition-colors outline-none"
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="text-[11px] text-stone-500 tabular-nums min-w-[4rem] text-center">
              <span className="font-mono text-stone-400">{page}</span>
              <span className="mx-1">/</span>
              <span className="font-mono">{totalPages}</span>
            </span>
            <Button
              isDisabled={page >= totalPages}
              onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-1 rounded text-stone-500 hover:text-stone-300 disabled:opacity-30 transition-colors outline-none"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SchemaTab({
  projectId,
  benchId,
  schema,
  table,
}: {
  projectId: string;
  benchId: number;
  schema: string;
  table: string;
}) {
  const { data, isLoading, isError } = useDbTableSchema(projectId, benchId, schema, table);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-sm text-stone-600">
        <Spinner /> Loading schema...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-stone-600">
        Failed to load schema.
      </div>
    );
  }

  return (
    <div className="space-y-8 p-4 overflow-auto">
      {/* Columns */}
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-3">
          Columns
        </h4>
        <div className="space-y-1">
          {data.columns.map((col) => (
            <div
              key={col.name}
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-stone-100 dark:bg-stone-900/50"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {col.isPrimaryKey && <Key size={11} className="text-amber-500 shrink-0" />}
                {col.isIdentity && !col.isPrimaryKey && (
                  <Hash size={11} className="text-blue-400 shrink-0" />
                )}
                <span className="text-sm font-mono text-stone-800 dark:text-stone-200 truncate">
                  {col.name}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <TypeBadge column={col} />
                {!col.isNullable && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400/70">
                    NOT NULL
                  </span>
                )}
                {col.defaultValue && (
                  <span
                    className="text-[10px] font-mono text-stone-400 dark:text-stone-600 max-w-[120px] truncate"
                    title={col.defaultValue}
                  >
                    = {col.defaultValue}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Indexes */}
      {data.indexes.length > 0 && (
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-3">
            Indexes
          </h4>
          <div className="space-y-1">
            {data.indexes.map((idx) => (
              <div
                key={idx.name}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-stone-100 dark:bg-stone-900/50"
              >
                <span className="text-sm font-mono text-stone-700 dark:text-stone-300 truncate flex-1">
                  {idx.name}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-mono text-stone-500">
                    ({idx.columns.join(", ")})
                  </span>
                  {idx.isPrimaryKey && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/70">
                      PK
                    </span>
                  )}
                  {idx.isUnique && !idx.isPrimaryKey && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400/70">
                      UNIQUE
                    </span>
                  )}
                  <span className="text-[10px] text-stone-400 dark:text-stone-600">{idx.type}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Keys */}
      {data.foreignKeys.length > 0 && (
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-3">
            Foreign Keys
          </h4>
          <div className="space-y-1">
            {data.foreignKeys.map((fk) => (
              <div
                key={fk.name}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-stone-100 dark:bg-stone-900/50"
              >
                <Link2 size={11} className="text-stone-400 dark:text-stone-600 shrink-0" />
                <span className="text-sm font-mono text-stone-700 dark:text-stone-300 truncate">
                  {fk.name}
                </span>
                <span className="text-[11px] text-stone-500 shrink-0">
                  <span className="font-mono text-stone-600 dark:text-stone-400">{fk.column}</span>
                  {" \u2192 "}
                  <span className="font-mono text-stone-600 dark:text-stone-400">
                    {fk.referencedTable}.{fk.referencedColumn}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DatabaseViewer({ projectId, benchId }: Props) {
  const {
    data: tables,
    isLoading: tablesLoading,
    isError: tablesError,
    error: tablesErrorObj,
  } = useDbTables(projectId, benchId);
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"data" | "schema">("data");

  const grouped = useMemo(() => {
    if (!tables) return new Map<string, DatabaseTable[]>();
    const map = new Map<string, DatabaseTable[]>();
    for (const t of tables) {
      const list = map.get(t.schema) || [];
      list.push(t);
      map.set(t.schema, list);
    }
    return map;
  }, [tables]);

  return (
    <div className="flex h-[calc(100vh-280px)] min-h-[400px] rounded-lg overflow-hidden bg-stone-50 dark:bg-stone-950/50">
      {/* Sidebar */}
      <div className="w-52 shrink-0 border-r border-stone-200 dark:border-stone-800/60 flex flex-col">
        <div className="px-3 py-2.5 border-b border-stone-200 dark:border-stone-800/40">
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
            Tables
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {tablesLoading ? (
            <div className="flex items-center justify-center py-8 gap-2 text-[11px] text-stone-500 dark:text-stone-600">
              <Spinner /> Loading...
            </div>
          ) : tablesError ? (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
              <AlertCircle size={14} className="text-red-400/70 shrink-0" />
              <span className="text-[11px] text-red-400/80 leading-relaxed">
                {(tablesErrorObj as Error)?.message ?? "Failed to load tables"}
              </span>
            </div>
          ) : !tables || tables.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-[11px] text-stone-500 dark:text-stone-600">
              No tables found.
            </div>
          ) : (
            Array.from(grouped.entries()).map(([schema, schemaTables]) => (
              <div key={schema}>
                <div className="px-3 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-600">
                    {schema}
                  </span>
                </div>
                {schemaTables.map((t) => {
                  const isActive = selected?.schema === t.schema && selected?.table === t.name;
                  return (
                    <Button
                      key={`${t.schema}.${t.name}`}
                      onPress={() => setSelected({ schema: t.schema, table: t.name })}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors outline-none ${
                        isActive
                          ? "bg-stone-200 dark:bg-stone-800/80 text-stone-900 dark:text-stone-100"
                          : "text-stone-500 dark:text-stone-400 hover:bg-stone-200/60 dark:hover:bg-stone-800/40 hover:text-stone-700 dark:hover:text-stone-300"
                      }`}
                    >
                      {t.type === "VIEW" ? (
                        <Eye size={12} className="shrink-0 text-stone-400 dark:text-stone-600" />
                      ) : (
                        <Table2 size={12} className="shrink-0 text-stone-400 dark:text-stone-600" />
                      )}
                      <span className="text-[12px] font-mono truncate">{t.name}</span>
                      {t.rowCount !== undefined && t.rowCount !== null && (
                        <span className="ml-auto text-[10px] text-stone-400 dark:text-stone-700 font-mono tabular-nums shrink-0">
                          {t.rowCount.toLocaleString()}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-stone-500 dark:text-stone-600">
            <Database size={28} className="text-stone-400 dark:text-stone-700" />
            <span className="text-sm">Select a table to browse</span>
          </div>
        ) : (
          <>
            {/* Table header with sub-tabs */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-200 dark:border-stone-800/60 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-stone-400 dark:text-stone-600 font-mono">
                  {selected.schema}.
                </span>
                <span className="text-sm font-semibold text-stone-800 dark:text-stone-200 font-mono">
                  {selected.table}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {(["data", "schema"] as const).map((tab) => (
                  <Button
                    key={tab}
                    onPress={() => setActiveTab(tab)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors outline-none capitalize ${
                      activeTab === tab
                        ? "bg-stone-200 dark:bg-stone-800 text-stone-800 dark:text-stone-200"
                        : "text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400"
                    }`}
                  >
                    {tab}
                  </Button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div className="flex-1 min-h-0">
              {activeTab === "data" ? (
                <DataTab
                  key={`${selected.schema}.${selected.table}`}
                  projectId={projectId}
                  benchId={benchId}
                  schema={selected.schema}
                  table={selected.table}
                />
              ) : (
                <SchemaTab
                  projectId={projectId}
                  benchId={benchId}
                  schema={selected.schema}
                  table={selected.table}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
