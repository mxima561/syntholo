"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Award, BookOpen, Boxes, ChartNoAxesCombined, CircleDollarSign, Headphones, LayoutDashboard, MessagesSquare, Settings, UsersRound, Workflow } from "lucide-react";

const adminNav = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/customers", label: "Customers", icon: UsersRound },
  { href: "/admin/content", label: "Course content", icon: BookOpen },
  { href: "/admin/support", label: "Support", icon: Headphones },
  { href: "/admin/certificates", label: "Certificates", icon: Award },
  { href: "/admin/community", label: "Community", icon: MessagesSquare },
  { href: "/admin/provisioning", label: "Provisioning", icon: Workflow },
  { href: "/admin/commerce", label: "Commerce", icon: CircleDollarSign },
  { href: "/admin/analytics", label: "Analytics", icon: ChartNoAxesCombined },
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return <div className="admin-shell"><aside className="admin-sidebar"><Link className="brand" href="/admin"><span className="brand-mark">S</span> Syntholo <i>ADMIN</i></Link><nav aria-label="Staff navigation">{adminNav.map((item) => { const active = pathname === item.href; return <Link aria-current={active ? "page" : undefined} className={active ? "active" : undefined} href={item.href} key={item.href}><item.icon aria-hidden="true" size={17} /> {item.label}</Link>; })}</nav><div className="admin-workspace"><Boxes aria-hidden="true" size={16} /><div><strong>Production workspace</strong><span>Authenticated staff access</span></div></div><Link aria-current={pathname === "/admin/settings" ? "page" : undefined} className={pathname === "/admin/settings" ? "admin-settings active" : "admin-settings"} href="/admin/settings"><Settings aria-hidden="true" size={16} /> Settings</Link></aside><div className="admin-content"><header><div><strong>Operations control center</strong><span>Private staff workspace</span></div><div>Staff session verified</div></header><main>{children}</main></div></div>;
}
