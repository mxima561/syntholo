import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoSoftwareAccount } from "@/lib/demo/data";
import { BusinessOsOnboarding } from "./business-os-onboarding";

describe("BusinessOsOnboarding", () => {
  it("starts provisioning after all questionnaire sections are complete", async () => {
    const user = userEvent.setup();
    render(<BusinessOsOnboarding initialAccount={demoSoftwareAccount} />);

    await user.click(screen.getByRole("checkbox", { name: /calendar and availability/i }));
    await user.click(screen.getByRole("checkbox", { name: /messaging registration/i }));
    await user.click(screen.getByRole("button", { name: /submit for provisioning/i }));

    expect(screen.getByText(/provisioning has started/i)).toBeInTheDocument();
  });
});
