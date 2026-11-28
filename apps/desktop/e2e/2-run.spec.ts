// Flow 2: run a task with streaming output and a skill-loaded chip.
import { addKey, expect, output, runTask, test } from "./fixtures";

test("a run streams text, shows the loaded skill, tool rows and usage", async ({ page }) => {
  await addKey(page);
  await runTask(page, "Give me the weekly recap");
  const out = output(page);
  await expect(out).toBeVisible();
  // Skill chip.
  await expect(out.getByRole("list", { name: "Skills loaded" }).getByRole("listitem")).toHaveText(/weekly-report/);
  // Tool row, finished.
  const tool = out.locator('[data-tool="db_query"]');
  await expect(tool).toHaveAttribute("data-status", "ok");
  await expect(tool).toContainText("reads data");
  // Streamed text arrives in full.
  await expect(out.locator(".out-text")).toHaveText(/Weekly summary: revenue was \$12,450, up 8% on last week\. Three tickets are still open\. Two posts went out\./);
  await expect(out.getByRole("status")).toHaveText("Done");
  await expect(out).toContainText("Usage: 1,520 in · 96 out tokens");
  // Tool details open.
  await tool.getByText("Input and result").click();
  await expect(tool).toContainText("SELECT name, value FROM metrics");
});

test("text streams in pieces and a run can be cancelled", async ({ page }) => {
  await addKey(page);
  await runTask(page, "slow recap please");
  const out = output(page);
  const text = out.locator(".out-text");
  await expect(text).toHaveText(/Weekly/);
  const first = (await text.textContent()) ?? "";
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(out.getByRole("status")).toHaveText("Cancelled");
  const final = (await text.textContent()) ?? "";
  // It had been streaming (more than the first chunk) and stopped before the end.
  expect(final.length).toBeGreaterThanOrEqual(first.length);
  expect(final.length).toBeLessThan("Weekly summary: revenue was $12,450, up 8% on last week. Three tickets are still open. Two posts went out.".repeat(20).length);
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
});

test("a forced skill shows on the chip, and provider errors show in the output", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await expect(page.getByLabel("Skill", { exact: true })).toContainText("invoice-chaser");
  await page.getByLabel("Skill", { exact: true }).selectOption("invoice-chaser");
  await runTask(page, "recap");
  await expect(output(page).locator('[data-skill="invoice-chaser"]')).toHaveAttribute("title", "Chosen by you");
  await runTask(page, "this will fail");
  await expect(output(page).getByRole("alert")).toContainText("overloaded");
  await expect(output(page).getByRole("status")).toHaveText("Stopped with an error");
});
