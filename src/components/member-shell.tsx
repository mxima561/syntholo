"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  BookOpen, CalendarDays, ClipboardCheck, Gauge, Headphones, LayoutGrid,
  MessageCircle, PanelsTopLeft, Settings, Sparkles, Workflow,
} from "lucide-react";

const navGroups = [
  {
    label: "Build",
    items: [
      { href: "/learn", label: "Home", icon: Gauge },
      { href: "/learn/plan", label: "30-day plan", icon: ClipboardCheck },
      { href: "/learn/course", label: "Course", icon: BookOpen },
      { href: "/learn/workflows", label: "Workflows", icon: Workflow },
      { href: "/learn/templates", label: "Templates", icon: LayoutGrid },
    ],
  },
  {
    label: "Learn together",
    items: [
      { href: "/learn/community", label: "Community", icon: MessageCircle },
      { href: "/learn/live", label: "Live sessions", icon: CalendarDays },
      { href: "/learn/support", label: "Human support", icon: Headphones },
    ],
  },
  {
    label: "Run",
    items: [
      { href: "/learn/business-os", label: "Business OS", icon: PanelsTopLeft },
      { href: "/learn/settings", label: "Settings", icon: Settings },
    ],
  },
] as const;

export function MemberShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="member-shell">
      <aside className="member-sidebar">
        <Link className="brand member-brand" href="/learn"><span className="brand-mark">S</span> Syntholo</Link>
        <nav aria-label="Member navigation">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => {
                const active = item.href === "/learn" ? pathname === item.href : pathname.startsWith(item.href);
                return (
                  <Link aria-current={active ? "page" : undefined} className={active ? "active" : ""} href={item.href} key={item.href}>
                    <item.icon size={16} /> {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-program">
          <Sparkles size={15} />
          <div><span>Academy access</span><strong>Lifetime course</strong><small>Human support through Jul 30, 2027</small></div>
        </div>
        <div className="member-identity"><span>MC</span><div><strong>Maria Chen</strong><small>Northstar Advisory</small></div></div>
      </aside>
      <div className="member-content">
        <header className="member-topbar">
          <div><span className="mobile-brand">Syntholo</span><strong>Northstar Advisory</strong><small>AI Operating System Academy</small></div>
          <div className="topbar-support"><span className="online-dot" /> Coaches online <Link href="/learn/support">Ask for help</Link></div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
