"use client";

import { StaffAccountListResponseSchema, type StaffAccountSummary } from "@syntholo/contracts/staff";
import { useEffect, useState } from "react";
import { createStaffApiClient } from "@/lib/api/client";

type LoadState = "loading" | "loaded" | "failed";

export function ProductionCustomers() {
  const api = createStaffApiClient();
  const [accounts, setAccounts] = useState<readonly StaffAccountSummary[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api("/v1/staff/accounts", { method: "GET" });
        if (cancelled) return;
        if (!response.ok) {
          setState("failed");
          return;
        }
        const parsed = StaffAccountListResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          setState("failed");
          return;
        }
        setAccounts(parsed.data.accounts);
        setState("loaded");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const normalizedSearch = search.trim().toLowerCase();
  const visible = normalizedSearch === "" ? accounts : accounts.filter((account) =>
    account.accountName.toLowerCase().includes(normalizedSearch)
    || (account.ownerEmail ?? "").toLowerCase().includes(normalizedSearch));

  return (
    <div className="admin-page production-customers">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Customers</span>
          <h1>Accounts</h1>
          <p>Find a real account by name or email — used when granting a course enrollment.</p>
        </div>
      </section>

      <section aria-labelledby="customers-title">
        <h2 id="customers-title">All accounts</h2>
        <div className="admin-search">
          <label className="sr-only" htmlFor="customer-search">Search</label>
          <input
            id="customer-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or email"
            value={search}
          />
        </div>
        {state === "loading" ? <p>Loading…</p> : null}
        {state === "failed" ? <p role="alert">Could not load accounts.</p> : null}
        {state === "loaded" && visible.length === 0 ? <p>No matching accounts.</p> : null}
        {state === "loaded" && visible.length > 0 ? (
          <div className="admin-table">
            <header>
              <span>Account</span>
              <span>Owner email</span>
              <span>Status</span>
              <span>Enrolled courses</span>
              <span aria-hidden="true" />
            </header>
            {visible.map((account) => (
              <div key={account.accountId}>
                <span><strong>{account.accountName}</strong></span>
                <span>{account.ownerEmail ?? "—"}</span>
                <span className={`status-pill ${account.status === "active" ? "live" : "paused"}`}>
                  {account.status}
                </span>
                <span>{account.enrolledCourseCount}</span>
                <span aria-hidden="true" />
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
