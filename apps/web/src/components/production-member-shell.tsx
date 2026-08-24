"use client";

import { useAuth } from "@clerk/react";
import { Award, BookOpen, FileText, Gauge, Menu, Workflow, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const links = [
  { href: "/learn", label: "Home", icon: Gauge },
  { href: "/learn/course", label: "Course", icon: BookOpen },
  { href: "/learn/plan", label: "Plan", icon: FileText },
  { href: "/learn/workflows", label: "Workflows", icon: Workflow },
  { href: "/learn/settings/certificates", label: "Certificates", icon: Award },
] as const;

function MemberNav({ onNavigate }: Readonly<{ onNavigate?: () => void }>) {
  const pathname = usePathname() ?? "/learn";
  return (
    <nav aria-label="Member navigation">
      <div className="nav-group">
        <span>Academy</span>
        {links.map((item) => {
          const active = item.href === "/learn" ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={active ? "active" : ""}
              href={item.href}
              key={item.href}
              onClick={onNavigate}
            >
              <item.icon aria-hidden="true" size={17} /> {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function ProductionMemberShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname() ?? "/learn";
  const { isLoaded, isSignedIn } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  if (!isLoaded || !isSignedIn) {
    return <>{children}</>;
  }

  return (
    <div className="member-shell production-member-shell">
      <aside className="member-sidebar production-member-sidebar">
        <Link className="brand member-brand" href="/learn"><span className="brand-mark">S</span> Syntholo</Link>
        <MemberNav />
        <div className="production-shell-note">
          <span className="micro-label">Academy workspace</span>
          <p>Course access and progress are loaded from your signed-in account.</p>
        </div>
      </aside>
      <div className="member-content">
        <header className="member-topbar production-member-topbar">
          <div>
            <button
              aria-controls="production-member-drawer"
              aria-expanded={drawerOpen}
              className="member-menu-button"
              onClick={() => setDrawerOpen((open) => !open)}
              type="button"
            >
              <Menu aria-hidden="true" size={18} />
              Menu
            </button>
            <span className="mobile-brand">Syntholo</span>
            <strong>AI Operating System Academy</strong>
            <small>Signed-in member workspace</small>
          </div>
          <Link aria-label="Browse Academy course" className="topbar-browse" href="/learn/course">
            <BookOpen aria-hidden="true" size={17} /><span>Browse course</span>
          </Link>
        </header>
        {drawerOpen ? (
          <div className="member-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
            <aside
              className="member-drawer"
              id="production-member-drawer"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="member-drawer-head">
                <Link className="brand member-brand" href="/learn" onClick={() => setDrawerOpen(false)}>
                  <span className="brand-mark">S</span> Syntholo
                </Link>
                <button className="member-drawer-close" onClick={() => setDrawerOpen(false)} type="button">
                  <X aria-hidden="true" size={18} />
                  Close
                </button>
              </div>
              <MemberNav onNavigate={() => setDrawerOpen(false)} />
            </aside>
          </div>
        ) : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
