import { useCallback, useEffect, useRef, useState, type CSSProperties, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

interface DropdownMenuProps {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom";
  minWidthClass?: string;
  portal?: boolean;
}

export const DropdownMenu: FC<DropdownMenuProps> = ({
  trigger,
  children,
  open,
  onOpenChange,
  align = "end",
  side = "bottom",
  minWidthClass = "min-w-56",
  portal = false,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  const updateTriggerRect = useCallback(() => {
    setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        onOpenChange(false);
      }
    };

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      if (portal) {
        window.addEventListener("resize", updateTriggerRect);
        document.addEventListener("scroll", updateTriggerRect, true);
      }
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", updateTriggerRect);
      document.removeEventListener("scroll", updateTriggerRect, true);
    };
  }, [open, onOpenChange, portal, updateTriggerRect]);

  const portalPosition: CSSProperties | undefined = triggerRect
    ? {
        ...(side === "bottom"
          ? { top: triggerRect.bottom + 8 }
          : { bottom: window.innerHeight - triggerRect.top + 8 }),
        ...(align === "end"
          ? { right: Math.max(8, window.innerWidth - triggerRect.right) }
          : align === "start"
            ? { left: Math.max(8, triggerRect.left) }
            : { left: triggerRect.left + (triggerRect.width / 2), transform: "translateX(-50%)" }),
      }
    : undefined;

  const menuContent = open ? (
    <div
      ref={menuRef}
      className={cn(
        "rounded-md border border-border bg-popover p-1 shadow-md",
        minWidthClass,
        portal
          ? cn(
              "fixed z-110",
              side === "bottom" ? "dropdown-menu-enter-bottom" : "dropdown-menu-enter-top",
            )
          : cn(
              "absolute z-80",
              side === "bottom" ? "dropdown-menu-enter-bottom" : "dropdown-menu-enter-top",
              side === "bottom" && "top-full mt-2 origin-top",
              side === "top" && "bottom-full mb-2 origin-bottom",
              align === "end" && "right-0",
              align === "start" && "left-0",
              align === "center" && "left-1/2 -translate-x-1/2",
            ),
      )}
      style={portal ? portalPosition : undefined}
    >
      {children}
    </div>
  ) : null;

  return (
    <div className="relative">
      <div
        ref={triggerRef}
        onClick={() => {
          const nextOpen = !open;
          if (nextOpen && portal) {
            updateTriggerRect();
          }
          onOpenChange(nextOpen);
        }}
      >
        {trigger}
      </div>

      {portal
        ? (menuContent && triggerRect ? createPortal(menuContent, document.body) : null)
        : menuContent}
    </div>
  );
};

interface DropdownMenuItemProps {
  children: ReactNode;
  onClick?: () => void;
  icon?: ReactNode;
  className?: string;
}

export const DropdownMenuItem: FC<DropdownMenuItemProps> = ({
  children,
  onClick,
  icon,
  className,
}) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-sm rounded-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus:bg-accent focus:text-accent-foreground focus:outline-none",
        "cursor-pointer",
        className
      )}
    >
      {icon && <span className="w-4 h-4">{icon}</span>}
      <span>{children}</span>
    </button>
  );
};

interface DropdownMenuSeparatorProps {
  className?: string;
}

export const DropdownMenuSeparator: FC<DropdownMenuSeparatorProps> = ({ className }) => {
  return <div className={cn("h-px my-1 bg-border", className)} />;
};
