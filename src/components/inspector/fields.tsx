import type { ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Controlled form-field primitives shared by every node-variant config form.
 * Each field is fully controlled: it renders the store value and emits parsed
 * domain values upward. Parsing/validation (number coercion, list splitting)
 * lives here so the per-variant forms stay declarative.
 *
 * Commit cadence is per-change (immediate). This is acceptable for the typical
 * single-selected-node edit; debouncing or onBlur-commit would be the next
 * optimization if editing very large graphs proves janky.
 */

interface FieldShellProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

const FieldShell = ({ label, hint, children }: FieldShellProps): JSX.Element => (
  <div className="flex flex-col gap-1">
    <Label>{label}</Label>
    {children}
    {hint !== undefined ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
  </div>
);

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

export const TextField = ({ label, value, onChange, placeholder }: TextFieldProps): JSX.Element => (
  <FieldShell label={label}>
    <Input
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      {...(placeholder !== undefined ? { placeholder } : {})}
    />
  </FieldShell>
);

export interface TextAreaFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rows?: number;
}

export const TextAreaField = ({ label, value, onChange, rows = 3 }: TextAreaFieldProps): JSX.Element => (
  <FieldShell label={label}>
    <Textarea rows={rows} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  </FieldShell>
);

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export const NumberField = ({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: NumberFieldProps): JSX.Element => (
  <FieldShell label={label}>
    <Input
      type="number"
      value={value}
      onChange={(event) => {
        const parsed = Number(event.currentTarget.value);
        // Ignore non-numeric intermediate input; never propagate NaN to the store.
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      {...(step !== undefined ? { step } : {})}
    />
  </FieldShell>
);

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface SelectFieldProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly onChange: (value: T) => void;
}

export const SelectField = <T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectFieldProps<T>): JSX.Element => (
  <FieldShell label={label}>
    <Select value={value} onChange={(event) => onChange(event.currentTarget.value as T)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  </FieldShell>
);

export interface StringListFieldProps {
  readonly label: string;
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
}

export const StringListField = ({ label, value, onChange }: StringListFieldProps): JSX.Element => (
  <FieldShell label={label} hint="Comma-separated">
    <Input
      value={value.join(', ')}
      onChange={(event) =>
        onChange(
          event.currentTarget.value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        )
      }
    />
  </FieldShell>
);
