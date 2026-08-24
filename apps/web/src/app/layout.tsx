import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PublicAuthProvider } from "@/components/public-auth";
import { inter, manrope } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Syntholo — Put AI to work in your life and your business",
    template: "%s · Syntholo",
  },
  description:
    "A practical school. Self-paced lessons, live sessions, and a person to help when you get stuck.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const content = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
    <PublicAuthProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}>
      {children}
    </PublicAuthProvider>
  ) : children;
  return (
    <html className={`${inter.variable} ${manrope.variable}`} data-scroll-behavior="smooth" lang="en">
      <body>{content}</body>
    </html>
  );
}
