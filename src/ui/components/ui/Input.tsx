import * as React from "react";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  parentClassName?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon, parentClassName, ...props }, ref) => {
    return (
      <div className={`relative ${parentClassName}`}>
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            {icon}
          </div>
        )}
        <input
          type={type}
          className={`flex h-11 w-full rounded-md border border-border 
            bg-input px-4 py-2 text-sm font-mono placeholder:text-muted-foreground/60 
            focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 
            transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 
            ${icon && "pl-10"} ${className}`}
          ref={ref}
          {...props}
        />
      </div>
    );
  }
);

export { Input };
