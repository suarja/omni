import { useMemo, type ReactElement } from "react";

import { Icon } from "../components/Icon";

export type CanvasSelectOption = Readonly<{
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}>;

export function CanvasSelect(
  props: Readonly<{
    label: string;
    value: string;
    options: readonly CanvasSelectOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    className?: string;
  }>,
): ReactElement {
  const groups = useMemo(() => {
    const values = new Map<string, CanvasSelectOption[]>();
    for (const option of props.options) {
      const group = option.group ?? "";
      values.set(group, [...(values.get(group) ?? []), option]);
    }
    return [...values.entries()];
  }, [props.options]);

  return (
    <label className={`canvas-select-field${props.className ? ` ${props.className}` : ""}`}>
      <span>{props.label}</span>
      <span className="canvas-select-control">
        <select
          aria-label={props.label}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
          value={props.value}
        >
          {props.placeholder !== undefined ? <option value="">{props.placeholder}</option> : null}
          {groups.map(([group, options]) =>
            group ? (
              <optgroup key={group} label={group}>
                {options.map((option) => (
                  <option disabled={option.disabled} key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              options.map((option) => (
                <option disabled={option.disabled} key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))
            ),
          )}
        </select>
        <Icon name="chevron-down" size={14} />
      </span>
    </label>
  );
}
