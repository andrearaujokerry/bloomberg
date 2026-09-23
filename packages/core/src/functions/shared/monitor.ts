// packages/core/src/functions/shared/monitor.ts
//
// The row and column shapes of every monitor grid — QM, W and WEI (FUNCTIONS_TIER1 §0.2).
//
// A monitor is a list of subjects and a list of columns; the cells are `ValueCell`s carrying their
// own state, reason and provenance index, so the grid renders TERM-12 staleness and Ctrl+I without
// the screen knowing where any value came from.

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { AssetClass, MarketSector } from '../../types/instrument.js';
import { requireField } from '../../fields/dictionary.js';
import { decimalsOf, formatOf } from '../../fields/format.js';
import type { FieldFormat } from '../../fields/format.js';

/** One live row of a monitor grid (QM, W, WEI). `subject` is the plant subject the row's cells follow. */
export interface MonitorRow {
  instrumentId: number;
  key: string;
  name: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  exchCode: string;
  gicsSector: string | null;
  /** 'q:42' */
  subject: string;
  /** keyed by column id (FieldId or 'c<n>' formula column) */
  cells: Record<string, ValueCell>;
}

/**
 * One column of a monitor grid. `fieldId` is absent on a CHRT-07 formula column, which carries
 * `formula` instead and whose id is `c<n>`.
 */
export interface MonitorColumn {
  id: string;
  label: string;
  fieldId?: FieldId;
  fmt: FieldFormat;
  decimals?: number;
  formula?: string;
}

/**
 * The column a dictionary field implies: label, rendering and decimals all come from
 * `core/fields/dictionary.ts` rather than from a table maintained beside it, so adding a field to a
 * monitor can never disagree with how the same field renders on DES or in a CSV.
 *
 * A dictionary `decimals` of `null` means "instrument price decimals or the unit default" — the
 * key is then omitted rather than set, because the formatter distinguishes "not specified" from a
 * specified 0 (`exactOptionalPropertyTypes` makes that distinction a type error to blur).
 *
 * Throws on an unknown field id: a monitor column naming a field the dictionary does not have is a
 * bug in the manifest, not a cell to render blank.
 */
export function monitorColumn(fieldId: FieldId): MonitorColumn {
  const def = requireField(fieldId);
  const decimals = decimalsOf(fieldId);
  const column: MonitorColumn = {
    id: fieldId,
    label: def.label,
    fieldId,
    fmt: formatOf(fieldId),
  };
  return decimals === null ? column : { ...column, decimals };
}
