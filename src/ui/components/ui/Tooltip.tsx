import type { ReactNode } from "react";

type TooltipProps = {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  contentClassName?: string;
  side?: "top" | "bottom";
  align?: "left" | "center" | "right";
};

const sideClasses = {
  top: "bottom-full mb-2",
  bottom: "top-full mt-2",
};

const alignClasses = {
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
  right: "right-0",
};

export const Tooltip = ({
  children,
  content,
  className = "",
  contentClassName = "",
  side = "top",
  align = "center",
}: TooltipProps) => {
  return (
    <span className={`relative inline-flex group/tooltip ${className}`}>
      {children}
      <span
        className={[
          "pointer-events-none absolute z-30 w-max max-w-80 rounded-md border border-border/80 bg-popover px-2.5 py-2 text-left text-[11px] text-popover-foreground shadow-md opacity-0 transition-all duration-150 ease-out group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          sideClasses[side],
          alignClasses[align],
          side === "top" ? "translate-y-1 group-hover/tooltip:translate-y-0 group-focus-within/tooltip:translate-y-0" : "-translate-y-1 group-hover/tooltip:translate-y-0 group-focus-within/tooltip:translate-y-0",
          contentClassName,
        ].join(" ")}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
};
