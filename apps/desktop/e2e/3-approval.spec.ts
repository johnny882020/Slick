// Flow 3: approval dialog, approve and deny.
import { addKey, expect, output, runTask, test } from "./fixtures";

test("approve: the action runs after the person approves", async ({ page }) => {
  await addKey(page);
  await runTask(page, "Send a reminder email to Acme");
  const dialog = page.getByRole("dialog", { name: "Approve this action?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Send an email to billing@acme.example");
  await expect(dialog).toContainText("sends a message");
  await expect(dialog).toContainText("Task: Send a reminder email to Acme");
  await expect(output(page).getByRole("status")).toHaveText("Waiting for your approval");
  // Approve is focused first.
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeFocused();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toBeHidden();
  const out = output(page);
  await expect(out.locator('[data-approval]')).toHaveAttribute("data-status", "approved");
  await expect(out.locator('[data-tool="email_send"]')).toHaveAttribute("data-status", "ok");
  await expect(out).toContainText("Done. I sent the reminder to Acme Ltd.");
  await expect(out.getByRole("status")).toHaveText("Done");
});

test("deny with a note: nothing is sent and the note reaches the model", async ({ page }) => {
  await addKey(page);
  await runTask(page, "Email the overdue reminder");
  const dialog = page.getByRole("dialog", { name: "Approve this action?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Note for OneSeat (optional)").fill("Wait until Friday");
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(dialog).toBeHidden();
  const out = output(page);
  await expect(out.locator('[data-approval]')).toHaveAttribute("data-status", "denied");
  await expect(out).toContainText('Okay, I did not send it. Your note: "Wait until Friday".');
  await expect(out.locator('[data-tool="email_send"]')).toHaveCount(0);
});

test("decide later: Escape keeps the request waiting and it can be reopened", async ({ page }) => {
  await addKey(page);
  await runTask(page, "Send the reminder");
  const dialog = page.getByRole("dialog", { name: "Approve this action?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(output(page).getByRole("status")).toHaveText("Waiting for your approval");
  await output(page).getByRole("button", { name: "Review request" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(output(page)).toContainText("Done. I sent the reminder");
});
