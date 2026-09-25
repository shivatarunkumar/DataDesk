"use client";

import { inputClass } from "./ui";

/** Admin rights for a while: a unit, then a value that fits it. At most 90 days. */
export const DURATION_UNITS = {
  minutes: { label: "Minutes", minutes: 1, values: [5, 10, 15, 30, 45] },
  hours: { label: "Hours", minutes: 60, values: [1, 2, 3, 4, 6, 8, 12, 18] },
  days: { label: "Days", minutes: 24 * 60, values: [1, 2, 3, 5, 7, 14, 30, 60, 90] },
} as const;

export type DurationUnit = keyof typeof DURATION_UNITS;
export type Duration = { unit: DurationUnit; value: number };

export const DEFAULT_DURATION: Duration = { unit: "hours", value: 1 };

export function toMinutes({ unit, value }: Duration): number {
  return value * DURATION_UNITS[unit].minutes;
}

/** The largest unit that divides it evenly: 120 → 2 hours, 90 → 90 minutes. */
export function fromMinutes(total: number): Duration {
  for (const unit of ["days", "hours", "minutes"] as const) {
    const size = DURATION_UNITS[unit].minutes;
    if (total % size === 0) return { unit, value: total / size };
  }
  return { unit: "minutes", value: total };
}

/** "1 hour", "3 days", "45 minutes" */
export function formatDuration(total: number): string {
  const { unit, value } = fromMinutes(total);
  const word = DURATION_UNITS[unit].label.toLowerCase();
  return `${value} ${value === 1 ? word.slice(0, -1) : word}`;
}

const selectClass = `${inputClass} font-normal`;

export function DurationPicker({
  value,
  onChange,
  label = "For how long",
}: {
  value: Duration;
  onChange: (value: Duration) => void;
  label?: string;
}) {
  const unit = DURATION_UNITS[value.unit];
  // a value from outside the list (e.g. an odd request) still shows as chosen
  const values = (unit.values as readonly number[]).includes(value.value)
    ? unit.values
    : [...unit.values, value.value].sort((a, b) => a - b);

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-3">
        <select
          aria-label="Unit"
          className={selectClass}
          value={value.unit}
          onChange={(e) => {
            const next = e.target.value as DurationUnit;
            onChange({ unit: next, value: DURATION_UNITS[next].values[0] });
          }}
        >
          {Object.entries(DURATION_UNITS).map(([key, u]) => (
            <option key={key} value={key}>
              {u.label}
            </option>
          ))}
        </select>
        <select
          aria-label={unit.label}
          className={selectClass}
          value={value.value}
          onChange={(e) => onChange({ unit: value.unit, value: Number(e.target.value) })}
        >
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}
