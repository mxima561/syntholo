import Link from "next/link";
import type { Route } from "next";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps<T extends string> = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  href?: Route<T>;
  variant?: "primary" | "secondary" | "dark" | "quiet";
  size?: "small" | "medium" | "large";
};

export function Button<T extends string>({
  children,
  className = "",
  href,
  variant = "primary",
  size = "medium",
  ...props
}: ButtonProps<T>) {
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
