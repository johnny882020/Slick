// Flow 6: schedules add/remove, and the activity log.
import { addKey, expect, output, runTask, test } from "./fixtures";

test("add, pause and remove a schedule", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
  const list = page.getByRole("region", { name: "Your schedules" });
  await expect(list).toContainText("No schedules yet.");

  const form = page.getByRole("form", { name: "Add a schedule" });
  const cron = form.getByLabel("Schedule (cron: minute hour day month weekday)");
  // Live validation and description.
  await cron.fill("0 9 * *");
  await expect(form).toContainText("A schedule has 5 parts");
  await expect(cron).toHaveAttribute("aria-invalid", "true");
  await form.getByLabel("Common times").selectOption({ label: "Every Monday at 9:00" });
  await expect(cron).toHaveValue("0 9 * * 1");
  await expect(form).toContainText("Every Monday at 09:00");
  await form.getByLabel("Task").fill("Send me the weekly report");
  await expect(form.getByLabel("Model")).toHaveValue("claude-opus-5-5");
  await form.getByRole("button", { name: "Add schedule" }).click();
  await expect(form.getByRole("status")).toHaveText("Added: Every Monday at 09:00.");

  const row = list.locator("tr[data-schedule]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Every Monday at 09:00");
  await expect(row).toContainText("0 9 * * 1");
  await expect(row).toContainText("Send me the weekly report");
  await expect(row).toContainText("Claude · claude-opus-5-5");

  // Pause it.
  await row.getByLabel("Enabled: Every Monday at 09:00").uncheck();
  await expect(row).toContainText("Paused");

  // A second one, then remove the first.
  await form.getByLabel("Common times").selectOption({ label: "Every weekday at 9:00" });
  await form.getByLabel("Task").fill("Triage support tickets");
  await form.getByRole("button", { name: "Add schedule" }).click();
  await expect(list.locator("tr[data-schedule]")).toHaveCount(2);
  await list.getByRole("button", { name: "Remove Every Monday at 09:00" }).click();
  await expect(list.locator("tr[data-schedule]")).toHaveCount(1);
  await expect(list).toContainText("Every weekday at 09:00");
  await list.getByRole("button", { name: "Remove Every weekday at 09:00" }).click();
  await expect(list).toContainText("No schedules yet.");
});

test("the activity log shows every action, with approvals", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Nothing yet." })).toBeVisible();

  // One approved send, one denied send.
  await runTask(page, "Send a reminder email to Acme");
  const dialog = page.getByRole("dialog", { name: "Approve this action?" });
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(output(page)).toContainText("Done. I sent the reminder");
  await runTask(page, "Send another reminder email");
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(output(page)).toContainText("Okay, I did not send it.");

  await page.getByRole("link", { name: "Activity" }).click();
  const rows = page.locator("tbody tr[data-tool]");
  await expect(rows).toHaveCount(4);
  // Newest first.
  await expect(rows.nth(0)).toHaveAttribute("data-tool", "email_send");
  await expect(rows.nth(0)).toContainText("Denied");
  await expect(rows.nth(0)).toContainText("was not sent");
  await expect(rows.nth(2)).toContainText("Approved");
  await expect(rows.nth(2)).toContainText("Sent reminder to billing@acme.example");
  await expect(rows.nth(1)).toContainText("Not needed");
  await expect(rows.nth(1)).toContainText("reads data");
  await expect(page.getByRole("status").filter({ hasText: "4 actions." })).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(rows).toHaveCount(4);
});
