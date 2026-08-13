import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { inter, manrope } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Syntholo — Put AI to work across your business",
    template: "%s · Syntholo",
  },
  description:
    "A practical AI operating system academy for professional-services businesses.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const content = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
    <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}>
      {children}
    </ClerkProvider>
  ) : children;
  return (
    <html className={`${inter.variable} ${manrope.variable}`} data-scroll-behavior="smooth" lang="en">
      <body>{content}</body>
    </html>
  );
}
