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
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map((toast) => (
        <Toast key={toast.id} variant={toast.variant} duration={toast.duration}>
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
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
