import { Download, FileText } from "lucide-react";
import { listCourseTemplates } from "@syntholo/db";
import { requireStudentAccount } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  await requireStudentAccount();
  const templates = await listCourseTemplates();
  return (
    <div className="member-page simple-page">
      <span className="eyebrow"><span className="eyebrow-dot" /> Working library</span>
      <h1>Templates</h1>
      <p>Practical documents your team can edit and use immediately. Downloads are markdown files you can open in any editor.</p>
      <div className="template-grid">
        {templates.map((template, index) => (
          <article key={template.id}>
            <span><FileText size={19} /></span>
            <small>Template 0{index + 1}</small>
            <h2>{template.title}</h2>
            <p>{template.description}</p>
            <a className="button button-secondary button-small" href={`/learn/templates/${template.id}/download`}>
              <Download size={14} /> Download
            </a>
          </article>
        ))}
      </div>
    </div>
  );
}
