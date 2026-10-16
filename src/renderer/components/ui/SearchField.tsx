import { useId, type ChangeEvent, type ReactElement } from "react";

import { Icon } from "../Icon";

export type SearchFieldProps = Readonly<{
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}>;

export function SearchField({ label, onChange, placeholder, value }: SearchFieldProps): ReactElement {
  const inputId = useId();
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(event.currentTarget.value);
  };

  return (
    <div className="ui-search-field">
      <Icon name="search" />
      <label className="ui-visually-hidden" htmlFor={inputId}>
        {label}
      </label>
      <input
        aria-label={label}
        id={inputId}
        onChange={handleChange}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </div>
  );
}
