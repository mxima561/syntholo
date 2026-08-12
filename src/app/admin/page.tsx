import { AlertTriangle, ArrowRight, BookOpenCheck, CircleDollarSign, Clock3, Headphones, Radio, UsersRound } from "lucide-react";
import Link from "next/link";

const metrics = [
  { label: "Active learners", value: "248", change: "+19 this month", icon: UsersRound },
  { label: "Monthly revenue", value: "$41.8k", change: "+12.4%", icon: CircleDollarSign },
  { label: "Course completion", value: "62%", change: "+4.1 points", icon: BookOpenCheck },
  { label: "Median coach reply", value: "18h", change: "Within target", icon: Headphones },
];

const attentionItems = [
  ["SLA warning", "Ortega Studio", "Coach response due in 6 hours", "/admin/support"],
  ["Provisioning blocked", "Northstar Advisory", "Messaging registration required", "/admin/provisioning"],
  ["Content report", "Growth Engine", "Member flagged an unsafe tool claim", "/admin/community"],
] as const;

export default function AdminOverviewPage() {
  return <div className="admin-page"><section className="admin-page-head"><div><span className="micro-label">Tuesday operating brief</span><h1>Good morning, Alex.</h1><p>Three items need attention across support and provisioning.</p></div><button type="button"><Radio size={14} /> System status: healthy</button></section><section className="admin-metric-grid">{metrics.map((metric) => <article key={metric.label}><span><metric.icon size={17} /></span><div><small>{metric.label}</small><strong>{metric.value}</strong><i>{metric.change}</i></div></article>)}</section><div className="admin-dashboard-grid"><section className="admin-panel attention-panel"><div className="admin-panel-head"><div><span className="micro-label">Operations queue</span><h2>Needs attention</h2></div><span>3 open</span></div>{attentionItems.map(([type, name, detail, href], index) => <Link href={href} key={name}><span className={index === 0 ? "warn" : ""}>{index === 0 ? <AlertTriangle size={14} /> : <Clock3 size={14} />}</span><div><small>{type}</small><strong>{name}</strong><p>{detail}</p></div><ArrowRight size={15} /></Link>)}</section><section className="admin-panel"><div className="admin-panel-head"><div><span className="micro-label">Learning</span><h2>Stage completion</h2></div><Link href="/admin/analytics">Details</Link></div><div className="stage-chart">{[["Diagnose",88],["Rules",74],["Growth",61],["Client",49],["Management",43],["Launch",38]].map(([name, value]) => <div key={name}><span>{name}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}%</strong></div>)}</div></section><section className="admin-panel wide-panel"><div className="admin-panel-head"><div><span className="micro-label">Revenue mix</span><h2>Commercial health</h2></div><span>Aug 2026</span></div><div className="revenue-strip"><div><strong>$24.7k</strong><span>Academy sales</span></div><div><strong>$9.1k</strong><span>Operator Club MRR</span></div><div><strong>$8.0k</strong><span>Business OS MRR</span></div><div><strong>4.2%</strong><span>Refund rate</span></div></div></section></div></div>;
}
