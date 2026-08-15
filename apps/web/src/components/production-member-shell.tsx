"use client";

import { BookOpen, FileText, Gauge, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const links = [
  { href: "/learn", label: "Home", icon: Gauge },
  { href: "/learn/course", label: "Course", icon: BookOpen },
  { href: "/learn/plan", label: "Plan", icon: FileText },
  { href: "/learn/workflows", label: "Workflows", icon: Workflow },
] as const;

export function ProductionMemberShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname() ?? "/learn";
  return (
    <div className="member-shell production-member-shell">
      <aside className="member-sidebar production-member-sidebar">
        <Link className="brand member-brand" href="/learn"><span className="brand-mark">S</span> Syntholo</Link>
        <nav aria-label="Member navigation">
          <div className="nav-group">
            <span>Academy</span>
            {links.map((item) => {
              const active = item.href === "/learn" ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link aria-current={active ? "page" : undefined} className={active ? "active" : ""} href={item.href} key={item.href}>
                  <item.icon aria-hidden="true" size={17} /> {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
        <div className="production-shell-note">
          <span className="micro-label">Academy workspace</span>
          <p>Course access and progress are loaded from your signed-in account.</p>
        </div>
      </aside>
      <div className="member-content">
        <header className="member-topbar production-member-topbar">
          <div><span className="mobile-brand">Syntholo</span><strong>AI Operating System Academy</strong><small>Signed-in member workspace</small></div>
          <Link aria-label="Browse Academy course" className="topbar-browse" href="/learn/course">
            <BookOpen aria-hidden="true" size={17} /><span>Browse course</span>
          </Link>
        </header>
        <div>{children}</div>
      </div>
    </div>
  );
}
