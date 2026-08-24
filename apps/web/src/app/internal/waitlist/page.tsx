import type { Metadata } from "next";
import { WaitlistForm } from "@/components/waitlist-form";

export const metadata: Metadata = {
  title: "Waitlist",
  robots: { index: false, follow: false },
};

export default function InternalWaitlistPage() {
  return <WaitlistForm framed />;
}
