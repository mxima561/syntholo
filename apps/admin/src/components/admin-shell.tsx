"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, Boxes, ChartNoAxesCombined, CircleDollarSign, Headphones, LayoutDashboard, MessagesSquare, ScrollText, Settings, Shield, UsersRound, Workflow } from "lucide-react";

const adminNav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/customers", label: "Students", icon: UsersRound },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/content", label: "Course content", icon: BookOpen },
  { href: "/support", label: "Support", icon: Headphones },
  { href: "/staff", label: "Staff", icon: Shield },
  { href: "/community", label: "Community", icon: MessagesSquare },
  { href: "/provisioning", label: "Provisioning", icon: Workflow },
  { href: "/commerce", label: "Commerce", icon: CircleDollarSign },
  { href: "/analytics", label: "Analytics", icon: ChartNoAxesCombined },
] as const;

type AdminShellProps = {
  children: ReactNode;
  identity: { initials: string; name: string };
};

export function AdminShell({ children, identity }: AdminShellProps) {
  const pathname = usePathname();

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo <i>ADMIN</i></Link>
        <nav>
          {adminNav.map((item) => (
            <Link className={pathname === item.href ? "active" : undefined} href={item.href} key={item.href}>
              <item.icon size={17} /> {item.label}
            </Link>
          ))}
        </nav>
        <div className="admin-workspace">
          <Boxes size={16} />
          <div><strong>Operations workspace</strong><span>Live Postgres · staff-authorized</span></div>
        </div>
        <Link className={pathname === "/settings" ? "admin-settings active" : "admin-settings"} href="/settings">
          <Settings size={16} /> Settings
        </Link>
      </aside>
      <div className="admin-content">
        <header>
          <div>
            <strong>Operations control center</strong>
            <span>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
          </div>
          <div>
            <span className="online-dot" /> Live data <span className="admin-avatar">{identity.initials}</span>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
