import type { Metadata } from "next";
import type { ReactNode } from "react";
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
  return (
    <html className={`${inter.variable} ${manrope.variable}`} lang="en">
      <body>{children}</body>
    </html>
  );
}

