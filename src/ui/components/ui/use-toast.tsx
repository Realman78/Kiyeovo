import * as React from "react";
import type { ToastVariant } from "./Toast";

type ToastMessage = {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
  actionLabel?: string;
  actionAltText?: string;
  onAction?: () => void;
};

type ToastContextValue = {
  toasts: ToastMessage[];
  addToast: (toast: Omit<ToastMessage, "id">) => void;
  removeToast: (id: string) => void;
  toast: {
    success: (message: string, title?: string) => void;
    error: (message: string, title?: string) => void;
    warning: (message: string, title?: string) => void;
    warningAction: (message: string, actionLabel: string, onAction: () => void, title?: string) => void;
    info: (message: string, title?: string) => void;
  };
};

const ToastContext = React.createContext<ToastContextValue | undefined>(undefined);

export function ToastContextProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);

  const addToast = React.useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...toast, id }]);

    // Auto-remove after duration (default 5 seconds)
    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useMemo(() => ({
    success: (message: string, title?: string) => {
      addToast({ description: message, title, variant: "success" });
    },
    error: (message: string, title?: string) => {
      addToast({ description: message, title, variant: "error" });
    },
    warning: (message: string, title?: string) => {
      addToast({ description: message, title, variant: "warning" });
    },
    warningAction: (message: string, actionLabel: string, onAction: () => void, title?: string) => {
      addToast({
        description: message,
        title,
        variant: "warning",
        actionLabel,
        actionAltText: actionLabel,
        onAction,
        duration: 10000,
      });
    },
    info: (message: string, title?: string) => {
      addToast({ description: message, title, variant: "info" });
    },
  }), [addToast]);

  const value = React.useMemo(
    () => ({ toasts, addToast, removeToast, toast }),
    [toasts, addToast, removeToast, toast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastContextProvider");
  }
  return context;
}
