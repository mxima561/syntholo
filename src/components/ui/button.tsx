import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  href?: string;
  variant?: "primary" | "secondary" | "dark" | "quiet";
  size?: "small" | "medium" | "large";
};

export function Button({
  children,
  className = "",
  href,
  variant = "primary",
  size = "medium",
  ...props
}: ButtonProps) {
  const classes = `button button-${variant} button-${size} ${className}`.trim();

  if (href) {
    return (
      <Link className={classes} href={href}>
        {children}
      </Link>
    );
  }

  return (
    <button className={classes} {...props}>
      {children}
    </button>
  );
}

