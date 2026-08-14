import { Download, FileText } from "lucide-react";
import { ProductionMemberAccess } from "@/components/production-member-access";
import { Button } from "@/components/ui/button";
import { isDemoMode } from "@/lib/config/mode";

const templates = ["AI opportunity scorecard", "Team AI policy", "Workflow design canvas", "Launch test plan", "90-day roadmap"];

export default function TemplatesPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  return <div className="member-page simple-page"><span className="eyebrow"><span className="eyebrow-dot" /> Working library</span><h1>Templates</h1><p>Practical documents your team can edit and use immediately.</p><div className="template-grid">{templates.map((name, index) => <article key={name}><span><FileText size={19} /></span><small>Template 0{index + 1}</small><h2>{name}</h2><p>Editable worksheet · DOCX and PDF</p><Button size="small" variant="secondary"><Download size={14} /> Download</Button></article>)}</div></div>;
}
