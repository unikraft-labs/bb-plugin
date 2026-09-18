import * as React from "react";

import { cn } from "../../lib/utils";
import { Input } from "./input.js";

const FloatingInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input"> & {
    label: string;
    containerClassName?: string;
  }
>(({ className, containerClassName, id, label, ...props }, ref) => {
  const generated = React.useId();
  const inputId = id ?? generated;
  return (
    <div className={cn("relative", containerClassName)}>
      <Input id={inputId} className={className} ref={ref} {...props} />
      <label
        htmlFor={inputId}
        className="absolute -top-1.5 left-2 bg-background px-1 text-xs leading-none text-muted-foreground"
      >
        {label}
      </label>
    </div>
  );
});
FloatingInput.displayName = "FloatingInput";

export { FloatingInput };
