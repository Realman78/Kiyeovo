import { useEffect, useRef, type FC, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface DropdownMenuProps {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: "start" | "end" | "center";
}

export const DropdownMenu: FC<DropdownMenuProps> = ({
  trigger,
  children,
  open,
  onOpenChange,
  align = "end",
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

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
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, onOpenChange]);

  return (
    <div className="relative">
      <div
        ref={triggerRef}
        onClick={() => onOpenChange(!open)}
      >
        {trigger}
      </div>

      {open && (
        <div
          ref={menuRef}
          className={cn(
            "absolute top-full mt-2 z-50 min-w-56 rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95",
            align === "end" && "right-0",
            align === "start" && "left-0",
            align === "center" && "left-1/2 -translate-x-1/2"
          )}
        >
          {children}
        </div>
      )}
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
