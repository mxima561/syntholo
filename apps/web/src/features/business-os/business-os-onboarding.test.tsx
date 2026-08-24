import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BusinessOsOnboarding } from "./business-os-onboarding";

vi.mock("@/app/learn/actions", () => ({
  toggleSoftwareItemAction: vi.fn(async () => undefined),
  submitSoftwareAction: vi.fn(async () => undefined),
}));

describe("BusinessOsOnboarding", () => {
  it("starts provisioning after all questionnaire sections are complete", async () => {
    const user = userEvent.setup();
    render(
      <BusinessOsOnboarding
        initialAccount={{
          id: "software-1",
          firstName: "Maria",
          status: "pending_onboarding",
          provisioningDueAt: null,
          checklist: [
            { id: "brand", label: "Brand and business details", complete: true },
            { id: "pipeline", label: "Pipeline stages", complete: true },
            { id: "calendar", label: "Calendar and availability", complete: false },
            { id: "messaging", label: "Messaging registration", complete: false },
            { id: "assistant", label: "AI assistant scope", complete: true },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: /calendar and availability/i }));
    await user.click(screen.getByRole("checkbox", { name: /messaging registration/i }));
    await user.click(screen.getByRole("button", { name: /submit for provisioning/i }));

    expect(screen.getByText(/provisioning has started/i)).toBeInTheDocument();
  });
});
