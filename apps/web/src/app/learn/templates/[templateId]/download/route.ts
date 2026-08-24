import { getCourseTemplate } from "@syntholo/db";
import { requireStudentAccount } from "@/lib/server/accounts";

export async function GET(_request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  await requireStudentAccount();
  const { templateId } = await params;
  const template = await getCourseTemplate(templateId);
  if (!template) return new Response("Not found", { status: 404 });
  return new Response(template.body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${template.filename}"`,
    },
  });
}
