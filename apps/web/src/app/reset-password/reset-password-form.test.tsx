import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResetPasswordForm } from "./reset-password-form";

vi.mock("@syntholo/auth/client", () => ({
  authClient: {
    resetPassword: vi.fn(),
    getSession: vi.fn(async () => ({ data: null })),
  },
}));

describe("password reset page", () => {
  it("does not bounce a reset token through sign-in or pricing", () => {
    const page = readFileSync("src/app/reset-password/page.tsx", "utf8");
    const form = readFileSync("src/app/reset-password/reset-password-form.tsx", "utf8");
    expect(page).not.toContain('redirect("/learn")');
    expect(page).not.toContain('redirect("/pricing")');
    expect(form).toContain("authClient.resetPassword");
    expect(form).toContain("newPassword");
  });

  it("asks for a new password when the email link includes a token", () => {
    render(<ResetPasswordForm errorCode="" token="reset-token" />);
    expect(screen.getByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /pricing/i })).not.toBeInTheDocument();
  });
});
