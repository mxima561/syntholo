"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="state-page"><span className="brand-mark">S</span><span className="micro-label">Something interrupted this page</span><h1>Your work is still safe.</h1><p>Try loading this area again. If it continues, the human support team can help.</p><Button onClick={reset} variant="dark"><RotateCcw size={15} /> Try again</Button><Button href="/learn/support" variant="quiet">Contact human support</Button></main>;
}
