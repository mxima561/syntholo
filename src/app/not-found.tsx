import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return <main className="state-page"><span className="brand-mark">S</span><span className="micro-label">404 · Page not found</span><h1>This path is not part of your workspace.</h1><p>Return to the command center and continue from your next best action.</p><Button href="/learn" variant="dark"><ArrowLeft size={15} /> Back to Syntholo</Button></main>;
}
