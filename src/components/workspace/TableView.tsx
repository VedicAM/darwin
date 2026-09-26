/**
 * Generic tabular output.
 *
 * The catch-all renderer: a tool that returns a list of objects gets a table
 * without anyone writing a component for it. `keyValue` flips the same data into
 * a field list, which is the right shape for a single-record result like a fold
 * summary.
 */

import { useMemo, useState } from "react";
import { Table2 } from "lucide-react";
import { cn } from "cn";
import type { CellValue, TableArtifact } from "@/lib/artifacts/types";
import { ArtifactHeader, EmptyState, Readout } from "./primitives";

function renderCell(value: CellValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function FieldList({ artifact }: { artifact: TableArtifact }) {
  return (
    <dl className="divide-border divide-y">
      {artifact.rows.map((row, rowIndex) =>
        artifact.columns.map((column) => {
          const value = row[column.key];
          return (
            <div
              key={`${rowIndex}-${column.key}`}
              className="hover:bg-muted/40 flex items-baseline gap-4 px-5 py-1.5 transition-colors"
            >
              <dt className="text-muted-foreground w-44 shrink-0 text-[11.5px]">{column.label}</dt>
              <dd
                className={cn(
                  "min-w-0 flex-1 font-mono text-[11.5px] break-words",
                  value === null && "text-muted-foreground/60",
                )}
              >
                {renderCell(value)}
              </dd>
            </div>
          );
        }),
      )}
    </dl>
  );
}

export function TableView({ artifact }: { artifact: TableArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const { columns, rows, droppedRows, keyValue } = artifact;
  const limit = 150;
  const visible = useMemo(() => (expanded ? rows : rows.slice(0, limit)), [expanded, rows]);

  if (rows.length === 0) {
    return <EmptyState icon={Table2} title="No rows" />;
  }

  return (
    <>
      <ArtifactHeader
        title={artifact.title}
        subtitle={`${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"} × ${columns.length} column${columns.length === 1 ? "" : "s"}`}
      />

      {keyValue ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FieldList artifact={artifact} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <thead className="bg-background sticky top-0 z-10">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "text-muted-foreground border-b border-border px-3 py-1.5 font-medium whitespace-nowrap",
                      column.numeric ? "text-right" : "text-left",
                    )}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-muted/40 transition-colors">
                  {columns.map((column) => {
                    const value = row[column.key];
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "border-border/60 max-w-80 truncate border-b px-3 py-1 font-mono whitespace-nowrap",
                          column.numeric ? "text-right tabular-nums" : "text-left",
                          value === null && "text-muted-foreground/50",
                        )}
                        title={typeof value === "string" ? value : undefined}
                      >
                        {renderCell(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Readout>
        {rows.length > limit ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Show fewer rows" : `Show all ${rows.length.toLocaleString()} rows`}
          </button>
        ) : null}
        {droppedRows && droppedRows > 0 ? (
          <span>
            {droppedRows.toLocaleString()} further row(s) were not loaded, to keep the table responsive.
          </span>
        ) : null}
      </Readout>
    </>
  );
}
