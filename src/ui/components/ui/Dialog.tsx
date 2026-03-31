import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm",
    "dialog-overlay-animate",
    className,
  ].filter(Boolean).join(" ");

  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className = "", children, ...props }, ref) => {
  const classes = [
    "fixed left-[50%] top-[50%] z-50 w-full max-w-xl translate-x-[-50%] translate-y-[-50%]",
    "bg-card border border-border rounded-lg shadow-lg",
    "glow-border",
    "dialog-content-animate",
    className,
  ].filter(Boolean).join(" ");

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={classes}
        {...props}
      >
        {/* Decorative corner accents */}
        <div className="absolute -top-px -left-px w-4 h-4 border-t-2 border-l-2 border-primary rounded-tl-lg" />
        <div className="absolute -top-px -right-px w-4 h-4 border-t-2 border-r-2 border-primary rounded-tr-lg" />
        <div className="absolute -bottom-px -left-px w-4 h-4 border-b-2 border-l-2 border-primary rounded-bl-lg" />
        <div className="absolute -bottom-px -right-px w-4 h-4 border-b-2 border-r-2 border-primary rounded-br-lg" />

        {children}

        <DialogPrimitive.Close className="absolute cursor-pointer right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-all hover:opacity-100 hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => {
  const classes = [
    "flex flex-col space-y-2 p-6 pb-4 border-b border-border/50",
    className,
  ].filter(Boolean).join(" ");

  return <div className={classes} {...props} />;
};
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => {
  const classes = [
    "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 p-6 pt-4 border-t border-border/50",
    className,
  ].filter(Boolean).join(" ");

  return <div className={classes} {...props} />;
};
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "text-lg font-semibold font-mono tracking-wide text-foreground",
    className,
  ].filter(Boolean).join(" ");

  return (
    <DialogPrimitive.Title
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className = "", ...props }, ref) => {
  const classes = [
    "text-sm text-muted-foreground",
    className,
  ].filter(Boolean).join(" ");

  return (
    <DialogPrimitive.Description
      ref={ref}
      className={classes}
      {...props}
    />
  );
});
DialogDescription.displayName = DialogPrimitive.Description.displayName;

const DialogBody = ({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => {
  const classes = ["p-6", className].filter(Boolean).join(" ");
  return <div className={classes} {...props} />;
};
DialogBody.displayName = "DialogBody";

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogBody,
};
