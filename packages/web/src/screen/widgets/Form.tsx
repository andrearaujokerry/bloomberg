// packages/web/src/screen/widgets/Form.tsx — SWPM's ticket, W's watchlist editor, SRCH's screener.
//
// Native controls, deliberately. A `boolean` field is a checkbox because `Space` must toggle it and
// a checkbox already does; a `number` field is `<input type="number">` because the arrows already
// step it. What is added on top is the terminal's own convention: `PageUp`/`PageDown` step by
// `bigStep` (a swap rate moves in 25 bp, not in 1 bp), `ArrowUp`/`ArrowDown` step by `step`, and
// `ArrowUp`/`ArrowDown` walk between fields on the controls where they are not already spoken for.
//
// A form is the one node kind that is deliberately more than one tab stop. Roving tabindex inside a
// form would be hostile — `Tab` between fields is what every user of every form already knows — and
// the node is still *reachable* by `Tab`, which is what the operability contract asks for.
//
// The values are local state seeded from the spec. Screens are pure functions re-run on every
// param change, so the fields arrive fresh on each render; the local copy is adopted again only
// when an incoming value actually changed, which is what keeps half-typed input alive across an
// unrelated re-render and still lets the screen push a new value in.

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { FormField, Node } from '../types.js';

export interface FormProps {
  node: Extract<Node, { kind: 'form' }>;
}

function seed(fields: readonly FormField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.id] = field.value;
  return out;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function Form({ node }: FormProps): ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>(() => seed(node.fields));
  const incoming = useRef<unknown[]>(node.fields.map((f) => f.value));

  useEffect(() => {
    const next = node.fields.map((f) => f.value);
    const changed =
      next.length !== incoming.current.length ||
      next.some((v, i) => !Object.is(v, incoming.current[i]));
    if (!changed) return;
    incoming.current = next;
    setValues(seed(node.fields));
  }, [node.fields]);

  const set = (id: string, value: unknown): void => {
    setValues((prev) => ({ ...prev, [id]: value }));
  };

  const submit = (): void => {
    node.onSubmit(values);
  };

  /** `PageUp`/`PageDown` on a number field step by `bigStep`; the arrows are the control's own. */
  const numberKeys = (e: ReactKeyboardEvent<HTMLInputElement>, field: FormField): void => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
    const big = field.bigStep ?? (field.step ?? 1) * 10;
    const current = asNumber(values[field.id]) ?? 0;
    e.preventDefault();
    set(field.id, e.key === 'PageUp' ? current + big : current - big);
  };

  return (
    <form
      className="form"
      data-node-id={node.id}
      aria-label={`Form ${node.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {node.fields.map((field) => {
        const inputId = `${node.id}-${field.id}`;
        const unitId = `${inputId}-unit`;
        const readonly = field.readonly === true;
        const describedBy = field.unit === undefined ? {} : { 'aria-describedby': unitId };
        let control: ReactElement;

        if (field.type === 'boolean') {
          control = (
            <input
              id={inputId}
              className="form__input"
              type="checkbox"
              checked={values[field.id] === true}
              disabled={readonly}
              data-field-type={field.type}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                set(field.id, e.target.checked);
              }}
            />
          );
        } else if (field.type === 'enum') {
          control = (
            <select
              id={inputId}
              className="form__input"
              value={asText(values[field.id])}
              disabled={readonly}
              data-field-type={field.type}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                set(field.id, e.target.value);
              }}
            >
              {(field.values ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          );
        } else if (field.type === 'number') {
          control = (
            <input
              id={inputId}
              className="form__input"
              type="number"
              inputMode="decimal"
              value={asText(values[field.id])}
              readOnly={readonly}
              data-field-type={field.type}
              {...(field.step === undefined ? {} : { step: field.step })}
              {...describedBy}
              onKeyDown={(e) => {
                numberKeys(e, field);
              }}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                set(field.id, e.target.value === '' ? null : Number(e.target.value));
              }}
            />
          );
        } else {
          // text, date, security and field all take typed text; `security` and `field` additionally
          // advertise which modal typeahead the shell should open (`ScreenCtx.prompt`).
          control = (
            <input
              id={inputId}
              className="form__input"
              type={field.type === 'date' ? 'date' : 'text'}
              value={asText(values[field.id])}
              readOnly={readonly}
              data-field-type={field.type}
              {...(field.type === 'security' || field.type === 'field'
                ? { 'data-prompt-kind': field.type }
                : {})}
              {...describedBy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                set(field.id, e.target.value);
              }}
            />
          );
        }

        return (
          <div className="form__field" key={field.id}>
            <label className="form__label" htmlFor={inputId}>
              {field.label}
            </label>
            {control}
            {field.unit === undefined ? null : (
              <span className="form__unit" id={unitId}>
                {field.unit}
              </span>
            )}
          </div>
        );
      })}
      <button type="submit" className="form__submit">
        {node.submitLabel ?? 'Submit'}
      </button>
    </form>
  );
}
