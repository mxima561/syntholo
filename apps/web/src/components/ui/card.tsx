import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  tone?: "surface" | "navy" | "soft";
};

export function Card({ children, className = "", tone = "surface", ...props }: CardProps) {
  return (
    <div className={`card card-${tone} ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}

