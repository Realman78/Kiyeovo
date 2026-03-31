import * as React from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { X, AlertCircle, CheckCircle, Info, AlertTriangle } from "lucide-react";

const ToastProvider = ToastPrimitives.Provider;

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "fixed top-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:top-auto sm:right-0 sm:bottom-0 sm:flex-col md:max-w-[420px]",
    className,
  ].filter(Boolean).join(" ");

  return (
    <ToastPrimitives.Viewport
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

type ToastVariant = "default" | "error" | "success" | "warning" | "info";

interface ToastProps extends React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> {
  variant?: ToastVariant;
}

const variantStyles: Record<ToastVariant, string> = {
  default: "border-border glow-border",
  error: "border-destructive/50 bg-destructive/10",
  success: "border-green-500/50 bg-green-500/10",
  warning: "border-warning/50 bg-warning/10",
  info: "border-blue-500/50 bg-blue-500/10",
};

const variantIcons: Record<ToastVariant, React.ReactNode> = {
  default: null,
  error: <AlertCircle className="h-5 w-5 text-destructive" />,
  success: <CheckCircle className="h-5 w-5 text-green-500" />,
  warning: <AlertTriangle className="h-5 w-5 text-warning" />,
  info: <Info className="h-5 w-5 text-blue-500" />,
};

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  ToastProps
>(({ className = "", variant = "default", children, ...props }, ref) => {
  const classes = [
    "group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-lg border p-4 pr-8 shadow-lg transition-all",
    "bg-card",
    "toast-animate",
    variantStyles[variant],
    className,
  ].filter(Boolean).join(" ");

  return (
    <ToastPrimitives.Root
      ref={ref}
      className={classes}
      {...props}
    >
      {/* Decorative corner accents - same as Dialog */}
      {/* <div className="absolute -top-px -left-px w-3 h-3 border-t-2 border-l-2 border-primary rounded-tl-lg" />
      <div className="absolute -top-px -right-px w-3 h-3 border-t-2 border-r-2 border-primary rounded-tr-lg" />
      <div className="absolute -bottom-px -left-px w-3 h-3 border-b-2 border-l-2 border-primary rounded-bl-lg" />
      <div className="absolute -bottom-px -right-px w-3 h-3 border-b-2 border-r-2 border-primary rounded-br-lg" /> */}

      <div className="flex items-center gap-3 flex-1">
        {variantIcons[variant]}
        {children}
      </div>
    </ToastPrimitives.Root>
  );
});
Toast.displayName = ToastPrimitives.Root.displayName;

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    className,
  ].filter(Boolean).join(" ");

  return (
    <ToastPrimitives.Action
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
ToastAction.displayName = ToastPrimitives.Action.displayName;

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100",
    className,
  ].filter(Boolean).join(" ");

  return (
    <ToastPrimitives.Close
      ref={ref}
      className={classes}
      toast-close=""
      {...props}
    >
      <X className="h-4 w-4" />
    </ToastPrimitives.Close>
  );
});
ToastClose.displayName = ToastPrimitives.Close.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "text-sm font-semibold text-foreground",
    className,
  ].filter(Boolean).join(" ");

  return (
    <ToastPrimitives.Title
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "text-sm opacity-90 text-foreground",
    className,
  ].filter(Boolean).join(" ");

  return (
    <ToastPrimitives.Description
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
ToastDescription.displayName = ToastPrimitives.Description.displayName;

export {
  type ToastProps,
  type ToastVariant,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
};
