import * as React from "react";
import type { ToastVariant } from "./Toast";

type ToastMessage = {
  id: string;
  open: boolean;
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
  addToast: (toast: Omit<ToastMessage, "id" | "open">) => void;
  removeToast: (id: string) => void;
  toast: {
    success: (message: string, title?: string) => void;
    error: (message: string, title?: string) => void;
    warning: (message: string, title?: string, duration?: number) => void;
    warningAction: (message: string, actionLabel: string, onAction: () => void, title?: string) => void;
    info: (message: string, title?: string) => void;
  };
};

const ToastContext = React.createContext<ToastContextValue | undefined>(undefined);
const TOAST_REMOVE_DELAY_MS = 250;

export function ToastContextProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const removalTimeoutsRef = React.useRef<Map<string, number>>(new Map());

  React.useEffect(() => {
    return () => {
      removalTimeoutsRef.current.forEach((timeout) => window.clearTimeout(timeout));
      removalTimeoutsRef.current.clear();
    };
  }, []);

  const addToast = React.useCallback((toast: Omit<ToastMessage, "id" | "open">) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...toast, id, open: true }]);
  }, []);

  const removeToast = React.useCallback((id: string) => {
    if (removalTimeoutsRef.current.has(id)) {
      return;
    }

    setToasts((prev) =>
      prev.map((toast) => toast.id === id ? { ...toast, open: false } : toast)
    );

    const timeout = window.setTimeout(() => {
      removalTimeoutsRef.current.delete(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, TOAST_REMOVE_DELAY_MS);

    removalTimeoutsRef.current.set(id, timeout);
  }, []);

  const toast = React.useMemo(() => ({
    success: (message: string, title?: string) => {
      addToast({ description: message, title, variant: "success" });
    },
    error: (message: string, title?: string) => {
      addToast({ description: message, title, variant: "error" });
    },
    warning: (message: string, title?: string, duration?: number) => {
      addToast({ description: message, title, variant: "warning", duration });
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
