/**
 * The generic table renderer every panel's table rides: one column's
 * header label and cell, plus the optional full-width `under` block
 * (PRJ-547) rendered in a colspan-everything row beneath the row it
 * belongs to.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { Renderable } from "./format.js";

export interface Column<Row> {
  label: string;
  cell: (row: Row) => Renderable;
  /**
   * Content too wide for a cell — the session logs (PRJ-547) — rendered
   * full-width in a colspan-everything row beneath the row it belongs
   * to. Answering null renders no second row.
   */
  under?: (row: Row) => TemplateResult | null;
}

export const table = <Row>(
  columns: Array<Column<Row>>,
  rows: Row[],
): TemplateResult => html`
  <table>
    <thead>
      <tr>
        ${columns.map((column) => html`<th>${column.label}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${rows.length === 0
        ? html`<tr>
            <td colspan="${columns.length}" class="muted">none</td>
          </tr>`
        : rows.map((row) => {
            const under = columns
              .map((column) => column.under?.(row) ?? null)
              .filter((block) => block !== null);
            return html`<tr>
                ${columns.map((column) => html`<td>${column.cell(row)}</td>`)}
              </tr>
              ${under.length === 0
                ? nothing
                : html`<tr class="row-log">
                    <td colspan="${columns.length}">${under}</td>
                  </tr>`}`;
          })}
    </tbody>
  </table>
`;
