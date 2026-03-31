import * as React from "react";

const baseClasses = "box-border inline-flex disabled:cursor-not-allowed cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium font-mono tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background  disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 uppercase";

const variantClasses = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90 glow-border hover:glow-border-intense",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  outline: "border border-primary/50 bg-transparent text-primary hover:bg-primary/10 hover:border-primary",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  link: "text-primary underline-offset-4 hover:underline",
};

const sizeClasses = {
  default: "h-10 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-12 rounded-md px-8 text-base",
  icon: "h-10 w-10",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantClasses;
  size?: keyof typeof sizeClasses;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "default", size = "default", ...props }, ref) => {
    const classes = [
      baseClasses,
      variantClasses[variant],
      sizeClasses[size],
      className,
    ].filter(Boolean).join(" ");

    return (
      <button
        className={classes}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
