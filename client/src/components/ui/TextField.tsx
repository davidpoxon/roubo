import type { ReactNode } from "react";
import {
  FieldError,
  Input,
  Label,
  Text,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import { FIELD_ERROR_CLASS, FIELD_LABEL_CLASS, inputClass } from "./styles";

export interface TextFieldProps extends Omit<AriaTextFieldProps, "className" | "children"> {
  /** The visible label. Pass `aria-label` instead when the context names the field. */
  label?: ReactNode;
  placeholder?: string;
  /** Helper text under the field. */
  description?: ReactNode;
  /** The message shown under the field while `isInvalid` is true. */
  errorMessage?: ReactNode;
  /** Set the value in JetBrains Mono (paths, commands, branch names). */
  mono?: boolean;
  /** Layout-only additions for the wrapper. */
  className?: string;
  /** Layout-only additions for the input (width). */
  inputClassName?: string;
}

/** The shared single-line text field. */
export default function TextField({
  label,
  placeholder,
  description,
  errorMessage,
  mono = false,
  className,
  inputClassName,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField {...props} className={className}>
      {label ? <Label className={FIELD_LABEL_CLASS}>{label}</Label> : null}
      <Input
        placeholder={placeholder}
        className={inputClass({ mono, className: inputClassName })}
      />
      {description ? (
        <Text slot="description" className="mt-1.5 block text-12 text-text-secondary">
          {description}
        </Text>
      ) : null}
      <FieldError className={FIELD_ERROR_CLASS}>{errorMessage}</FieldError>
    </AriaTextField>
  );
}
