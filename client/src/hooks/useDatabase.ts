import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useDbTables(projectId: string, benchId: number, enabled = true) {
  return useQuery({
    queryKey: ["db-tables", projectId, benchId],
    queryFn: () => api.fetchDbTables(projectId, benchId),
    enabled,
  });
}

export function useDbTableData(
  projectId: string,
  benchId: number,
  schema: string,
  table: string,
  page: number,
  pageSize: number,
) {
  return useQuery({
    queryKey: ["db-table-data", projectId, benchId, schema, table, page, pageSize],
    queryFn: () => api.fetchDbTableData(projectId, benchId, schema, table, page, pageSize),
    enabled: !!table,
  });
}

export function useDbTableSchema(
  projectId: string,
  benchId: number,
  schema: string,
  table: string,
) {
  return useQuery({
    queryKey: ["db-table-schema", projectId, benchId, schema, table],
    queryFn: () => api.fetchDbTableSchema(projectId, benchId, schema, table),
    enabled: !!table,
  });
}
