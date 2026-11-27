// Flow 7: the Plan screen — Free by default, activate a license, the computer limit error,
// back to Free, and sending feedback.
import { addKey, expect, test } from "./fixtures";

test("plan: free by default, activate a key, limits, deactivate", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Plan" }).click();
  await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
  const summary = page.getByTestId("plan-summary");
  await expect(summary).toContainText("Free: one computer and the seven starter skills.");
  const features = page.getByRole("list", { name: "Plan features" });
  await expect(features.locator('[data-feature="pinned_apps"]')).toContainText("(Pro and Team)");

  const key = page.getByRole("textbox", { name: "License key" });
  const status = page.getByRole("region", { name: "License key" }).getByRole("status");
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(status).toHaveText("Paste a license key first.");
  await key.fill("not-a-key");
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(status).toContainText("does not look like a OneSeat license key");
  await key.fill("OS-9999-AAAA-BBBB-CCCC");
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(status).toContainText("already used on 3 of 3 computers");

  await key.fill("os-7k2m-q9px-4htr-wb3d");
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(status).toHaveText("Activated: Pro.");
  await expect(summary).toContainText("Pro, up to 3 computers, for pilot@example.com.");
  await expect(features.locator('[data-feature="pinned_apps"]')).not.toContainText("(Pro and Team)");
  await expect(features.locator('[data-feature="priority_support"]')).toContainText("(Pro and Team)");
  await expect(key).toHaveValue("");

  await page.getByRole("button", { name: "Use Free on this computer" }).click();
  await expect(summary).toContainText("Free");
  await expect(page.getByRole("button", { name: "Use Free on this computer" })).toBeHidden();
});

test("plan: send feedback", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Plan" }).click();
  const fb = page.getByRole("region", { name: "Send feedback" });
  await fb.getByRole("button", { name: "Send feedback" }).click();
  await expect(fb.getByRole("status")).toHaveText("Write a few words first.");
  await fb.getByLabel("What happened?").fill("The invoice total was right first time.");
  await fb.getByLabel("Rating").selectOption({ label: "5 of 5" });
  await fb.getByLabel("Topic").fill("invoices");
  await fb.getByRole("button", { name: "Send feedback" }).click();
  await expect(fb.getByRole("status")).toHaveText("Thank you! Your feedback was sent.");
  await expect(fb.getByLabel("What happened?")).toHaveValue("");
});
