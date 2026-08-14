import Link from "next/link";
import type { Route } from "next";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { UrlObject } from "url";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "dark"
  | "quiet"
  | "human"
  | "milestone";

type ButtonProps<T extends string> = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  href?: Route<T> | UrlObject;
  variant?: ButtonVariant;
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
