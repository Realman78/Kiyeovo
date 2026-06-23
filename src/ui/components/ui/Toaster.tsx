import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./Toast";
import { useToast } from "./use-toast";

export function Toaster() {
  const { toasts, removeToast } = useToast();

  return (
    <ToastProvider>
      {toasts.map((toast) => {
        const duration = toast.duration !== undefined && toast.duration <= 0
          ? Infinity
          : toast.duration;

        return (
          <Toast
            key={toast.id}
            open={toast.open}
            variant={toast.variant}
            duration={duration}
            onOpenChange={(open) => {
              if (!open) {
                removeToast(toast.id);
              }
            }}
            className={toast.actionLabel ? "md:w-[550px]" : "md:w-[420px]"}
          >
            <div className="grid gap-1">
              {toast.title && <ToastTitle>{toast.title}</ToastTitle>}
              {toast.description && (
                <ToastDescription>{toast.description}</ToastDescription>
              )}
            </div>
            {toast.actionLabel && toast.onAction && (
              <ToastAction altText={toast.actionAltText || toast.actionLabel} onClick={toast.onAction}>
                {toast.actionLabel}
              </ToastAction>
            )}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
