"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  BookOpen, CalendarDays, ClipboardCheck, Gauge, Headphones, LayoutGrid,
  MessageCircle, PanelsTopLeft, Settings, ShieldCheck, Sparkles, Workflow,
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

type MemberShellProps = {
  children: ReactNode;
  identity: { initials: string; name: string; subtitle: string };
  isAdmin: boolean;
};

export function MemberShell({ children, identity, isAdmin }: MemberShellProps) {
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
          {isAdmin ? (
            <div className="nav-group">
              <span>Admin</span>
              <Link className={pathname.startsWith("/admin") ? "active" : ""} href="/admin">
                <ShieldCheck size={16} /> Admin panel
              </Link>
            </div>
          ) : null}
        </nav>
        <div className="sidebar-program">
          <Sparkles size={15} />
          <div><span>Academy access</span><strong>Lifetime course</strong><small>{identity.subtitle}</small></div>
        </div>
        <div className="member-identity">
          <span>{identity.initials}</span>
          <div><strong>{identity.name}</strong><small>Signed in with WorkOS</small></div>
          <form action="/signout" method="get">
            <button className="signout-link" type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="member-content">
        <header className="member-topbar">
          <div><span className="mobile-brand">Syntholo</span><strong>{identity.name}</strong><small>{identity.subtitle}</small></div>
          <div className="topbar-actions">
            <Link aria-label="Browse lessons and templates" className="topbar-browse" href="/learn/course">
              <BookOpen aria-hidden="true" size={16} />
              <span>Browse lessons and templates</span>
            </Link>
            <span className="status-chip"><span className="online-dot" /> Coaches online</span>
            <span className="status-chip status-chip-course">Academy access</span>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
