"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, Boxes, ChartNoAxesCombined, CircleDollarSign, Headphones, LayoutDashboard, MessagesSquare, ScrollText, Settings, Shield, UsersRound, Workflow } from "lucide-react";

type AdminCapabilities = {
  billing: boolean;
  content: boolean;
  support: boolean;
  staffAdmin: boolean;
};

const DEFAULT_CAPABILITIES: AdminCapabilities = {
  billing: true,
  content: true,
  support: true,
  staffAdmin: true,
};

const adminNav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/customers", label: "Students", icon: UsersRound },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/content", label: "Course content", icon: BookOpen, capability: "content" },
  { href: "/support", label: "Support", icon: Headphones, capability: "support" },
  { href: "/staff", label: "Staff", icon: Shield, capability: "staffAdmin" },
  { href: "/community", label: "Community", icon: MessagesSquare },
  { href: "/provisioning", label: "Provisioning", icon: Workflow },
  { href: "/commerce", label: "Commerce", icon: CircleDollarSign, capability: "billing" },
  { href: "/analytics", label: "Analytics", icon: ChartNoAxesCombined },
] as const;

type AdminShellProps = {
  children: ReactNode;
  identity: { initials: string; name: string };
  capabilities?: AdminCapabilities;
};

export function AdminShell({ children, identity, capabilities = DEFAULT_CAPABILITIES }: AdminShellProps) {
  const pathname = usePathname();
  const visibleNav = adminNav.filter((item) => !("capability" in item) || capabilities[item.capability]);

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo <i>ADMIN</i></Link>
        <nav>
          {visibleNav.map((item) => (
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
