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
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  return (
    <html className={`${inter.variable} ${manrope.variable}`} data-scroll-behavior="smooth" lang="en">
      <body>
        {publishableKey ? <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider> : children}
      </body>
    </html>
  );
}
