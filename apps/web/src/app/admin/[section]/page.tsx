import { notFound } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";

const sections = {
  customers: { eyebrow: "Customer operations", title: "Customers", description: "Manage business workspaces, seats, purchases, cohorts, and entitlements.", rows: [["Northstar Advisory", "3 seats", "Academy", "Active"], ["Ortega Studio", "3 seats", "Operator Club", "Active"], ["Brooks & Field", "2 seats", "Academy", "Active"]] },
  support: { eyebrow: "Coach operations", title: "Support queue", description: "Assign, prioritize, and resolve every human support conversation.", rows: [["Ortega Studio", "Workflow review", "Due in 6h", "Warning"], ["Northstar Advisory", "Waiting on customer", "SLA paused", "Paused"], ["Brooks & Field", "Tool selection", "Due tomorrow", "Healthy"]] },
  community: { eyebrow: "Trust and moderation", title: "Community reports", description: "Review reports and hide, restore, lock, or remove content with an audit trail.", rows: [["Growth Engine", "Unsafe tool claim", "1 report", "Review"], ["Tool Questions", "Affiliate disclosure", "2 reports", "Review"], ["Implementation Wins", "Resolved report", "0 open", "Healthy"]] },
  commerce: { eyebrow: "Revenue operations", title: "Commerce", description: "Review purchases, renewals, coupons, refunds, and entitlement changes.", rows: [["Academy", "$24.7k", "62 sales", "4.2% refund"], ["Operator Club", "$9.1k MRR", "154 active", "2.1% churn"], ["Business OS", "$8.0k MRR", "40 active", "1 paused"]] },
  analytics: { eyebrow: "Product intelligence", title: "Analytics", description: "Track acquisition, activation, outcomes, support, retention, and revenue.", rows: [["Scorecard completion", "71%", "+6 points", "Healthy"], ["30-day activation", "64%", "+3 points", "Healthy"], ["Workflow launch", "52%", "+8 points", "Improving"]] },
  settings: { eyebrow: "Administration", title: "Settings", description: "Manage coaches, roles, service levels, notifications, and workspace configuration.", rows: [["Coaches", "4 active", "2 regions", "Configured"], ["Security roles", "4 roles", "Least privilege", "Configured"], ["Notifications", "12 transactional", "Weekly digest", "Configured"]] },
} as const;

export default async function AdminSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const data = sections[section as keyof typeof sections];
  if (!data) notFound();
  return <div className="admin-page"><section className="admin-page-head"><div><span className="micro-label">{data.eyebrow}</span><h1>{data.title}</h1><p>{data.description}</p></div><label className="admin-search"><Search size={14} /><span className="sr-only">Search {data.title}</span><input placeholder={`Search ${data.title.toLowerCase()}`} /></label></section><section className="admin-table"><header><span>Name</span><span>Detail</span><span>Measure</span><span>Status</span><span /></header>{data.rows.map((row) => <button key={row[0]} type="button"><strong>{row[0]}</strong><span>{row[1]}</span><span>{row[2]}</span><i className={`status-pill ${row[3].toLowerCase()}`}>{row[3]}</i><ArrowRight size={14} /></button>)}</section></div>;
}
