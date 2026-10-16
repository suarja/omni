import type { ReactElement } from "react";

export type SegmentedOption<Value extends string> = Readonly<{
  label: string;
  value: Value;
  /** Shown but not selectable (an option that does not exist yet); the host says why elsewhere. */
  disabled?: boolean;
}>;

export type SegmentedControlProps<Value extends string> = Readonly<{
  ariaLabel: string;
  onValueChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  value: Value;
}>;

export function SegmentedControl<Value extends string>({
  ariaLabel,
  onValueChange,
  options,
  value,
}: SegmentedControlProps<Value>): ReactElement {
  return (
    <div aria-label={ariaLabel} className="ui-segmented-control" role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={option.value === value ? "ui-segmented-control__item is-selected" : "ui-segmented-control__item"}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onValueChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
