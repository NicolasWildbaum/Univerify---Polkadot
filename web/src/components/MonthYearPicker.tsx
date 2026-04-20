// Two-dropdown month + year picker that emits a Schema-v2 canonical
// `YYYY-MM` string. We avoid `<input type="month">` because its display
// follows the browser locale (so a Spanish-language verifier sees "julio
// 2026" while the English-language issuer saw "July 2026") — using
// dropdowns with hard-coded English month labels keeps the UX identical
// across locales without changing what we hash.
//
// Fully controlled: month and year are derived from `value` on every
// render, no local state. This sidesteps the
// `react-hooks/set-state-in-effect` lint rule and keeps the parent's
// string the single source of truth (e.g. for query-param prefills).
//
// Partial-selection trick: when only month or only year is picked we
// still need to remember it across renders without triggering the
// "single source of truth" pattern's reset. We encode partial state in
// the value itself with sentinel forms `"--MM"` (month-only) and
// `"YYYY-"` (year-only). Neither matches `^\d{4}-\d{2}$`, so
// `normalizeClaims` in the parent treats them as "not ready" — which
// is exactly what we want until both dropdowns are filled.

import { useMemo } from "react";

const MONTHS_EN = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/// Parse the picker's `value`, which may be one of:
///   - `""`                    nothing selected
///   - `"YYYY-MM"`             both selected (canonical)
///   - `"YYYY-MM-DD"`          legacy full ISO date (day discarded)
///   - `"--MM"`                month-only sentinel (year cleared)
///   - `"YYYY-"`               year-only sentinel (month cleared)
function parsePickerValue(value: string): {
	year: number | null;
	month: number | null;
} {
	const trimmed = value.trim();
	if (trimmed === "") return { year: null, month: null };

	const full = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(trimmed);
	if (full) {
		const m = Number(full[2]);
		return { year: Number(full[1]), month: m >= 1 && m <= 12 ? m : null };
	}

	const monthOnly = /^--(\d{2})$/.exec(trimmed);
	if (monthOnly) {
		const m = Number(monthOnly[1]);
		return { year: null, month: m >= 1 && m <= 12 ? m : null };
	}

	const yearOnly = /^(\d{4})-$/.exec(trimmed);
	if (yearOnly) {
		return { year: Number(yearOnly[1]), month: null };
	}

	return { year: null, month: null };
}

/// Build the picker's `value` string from the current (possibly partial)
/// month+year selection. Mirrors the shapes that `parsePickerValue` accepts.
function encodePickerValue(month: number | null, year: number | null): string {
	if (month !== null && year !== null) {
		return `${year}-${String(month).padStart(2, "0")}`;
	}
	if (month !== null) return `--${String(month).padStart(2, "0")}`;
	if (year !== null) return `${year}-`;
	return "";
}

interface Props {
	label: string;
	value: string;
	onChange: (yyyyMm: string) => void;
	/** Inclusive lower bound for the year dropdown. Defaults to 1950. */
	minYear?: number;
	/** Inclusive upper bound. Defaults to current year + 1 (graduations
	 *  scheduled for next year are common). */
	maxYear?: number;
	helpText?: string;
}

export function MonthYearPicker({
	label,
	value,
	onChange,
	minYear = 1950,
	maxYear,
	helpText,
}: Props) {
	const effectiveMaxYear = maxYear ?? new Date().getFullYear() + 1;

	const { month, year } = parsePickerValue(value);

	const years = useMemo(() => {
		const list: number[] = [];
		for (let y = effectiveMaxYear; y >= minYear; y--) list.push(y);
		return list;
	}, [minYear, effectiveMaxYear]);

	function handleMonthChange(e: React.ChangeEvent<HTMLSelectElement>) {
		const next = e.target.value === "" ? null : Number(e.target.value);
		onChange(encodePickerValue(next, year));
	}

	function handleYearChange(e: React.ChangeEvent<HTMLSelectElement>) {
		const next = e.target.value === "" ? null : Number(e.target.value);
		onChange(encodePickerValue(month, next));
	}

	const displayLabel =
		month !== null && year !== null ? `${MONTHS_EN[month - 1]} ${year}` : null;

	return (
		<div>
			<label className="label">{label}</label>
			<div className="grid grid-cols-2 gap-2">
				<select
					value={month ?? ""}
					onChange={handleMonthChange}
					className="input-field w-full"
					aria-label={`${label} — month`}
				>
					<option value="">Month</option>
					{MONTHS_EN.map((name, idx) => (
						<option key={name} value={idx + 1}>
							{name}
						</option>
					))}
				</select>
				<select
					value={year ?? ""}
					onChange={handleYearChange}
					className="input-field w-full"
					aria-label={`${label} — year`}
				>
					<option value="">Year</option>
					{years.map((y) => (
						<option key={y} value={y}>
							{y}
						</option>
					))}
				</select>
			</div>
			{(displayLabel || helpText) && (
				<p className="text-xs text-text-muted mt-1">
					{displayLabel && (
						<>
							Selected: <strong className="text-text-primary">{displayLabel}</strong>
							{helpText ? " · " : null}
						</>
					)}
					{helpText}
				</p>
			)}
		</div>
	);
}
