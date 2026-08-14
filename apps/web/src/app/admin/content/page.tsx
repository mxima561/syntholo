import { Archive, Eye, GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { AdminAccessState } from "@/components/admin-access-state";
import { Button } from "@/components/ui/button";
import { requireAdminAccess } from "@/lib/auth/staff-access";
import { academyCourse } from "@/lib/domain/course";

export default async function AdminContentPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return <div className="admin-page"><section className="admin-page-head"><div><span className="micro-label">Structured editor</span><h1>Course content</h1><p>Manage stage order, blocks, releases, publication, and versions.</p></div><Button size="small"><Plus size={14} /> New lesson</Button></section><section className="content-editor-panel"><header><div><span className="status-pill live">Published</span><h2>{academyCourse.title}</h2><p>Version 12 · Updated 42 minutes ago by Alex Rivera</p></div><div><Button size="small" variant="secondary"><Eye size={14} /> Preview</Button><Button size="small">Publish changes</Button></div></header><div className="content-stage-list">{academyCourse.stages.map((stage) => <section key={stage.id}><div><GripVertical size={14} /><span>0{stage.number}</span><div><strong>{stage.title}</strong><small>{stage.lessons.length} lessons · Release week {stage.releaseWeek}</small></div><button aria-label={`More actions for ${stage.title}`} type="button"><MoreHorizontal size={15} /></button></div>{stage.lessons.map((lesson) => <article key={lesson.id}><GripVertical size={13} /><span>{lesson.number}</span><div><strong>{lesson.title}</strong><small>Video · assignment · {lesson.resourceCount} resources</small></div><i>{lesson.durationMinutes} min</i><span className="status-pill live">Published</span></article>)}</section>)}</div><footer><Archive size={14} /> Version history preserves every published change.</footer></section></div>;
}
