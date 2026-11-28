// Pilot feedback: "Removed a skill (social posts) and can't restore it. Also, can't add new
// skills from skills.sh." Remove a starter skill and restore it; search skills.sh and install
// a result through the inspect report.
import { addKey, expect, test } from "./fixtures";

test("a removed starter skill can be restored", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Skills" }).click();
  const installed = page.getByRole("region", { name: "Installed skills" });
  const removedSection = page.getByRole("region", { name: "Removed starter skills" });
  await expect(installed.locator('[data-skill="social-posts"]')).toBeVisible();
  // Nothing removed yet: the section is not shown.
  await expect(removedSection).toHaveCount(0);

  const card = installed.locator('[data-skill="social-posts"]');
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await card.getByRole("button", { name: "Remove social-posts" }).click();
  await expect(installed.locator('[data-skill="social-posts"]')).toHaveCount(0);

  await expect(removedSection).toBeVisible();
  const restorable = removedSection.locator('[data-restorable="social-posts"]');
  await expect(restorable).toContainText("social media posts");
  await restorable.getByRole("button", { name: "Restore social-posts" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Restored social-posts." })).toBeVisible();
  await expect(installed.locator('[data-skill="social-posts"]')).toBeVisible();
  await expect(removedSection).toHaveCount(0);
});

test("search skills.sh, inspect a result and install it", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Skills" }).click();
  const search = page.getByRole("search", { name: "Find skills on skills.sh" });
  const add = page.getByRole("form", { name: "Add a skill" });
  const installed = page.getByRole("region", { name: "Installed skills" });

  // Empty and error states in plain words.
  await search.getByRole("button", { name: "Search" }).click();
  await expect(search.getByRole("status")).toHaveText("Type what the skill should help with, like “invoices”.");
  await search.getByLabel("Search skills.sh").fill("zzz-nothing");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(search.getByRole("status")).toContainText("Nothing on skills.sh matches “zzz-nothing”.");
  await search.getByLabel("Search skills.sh").fill("offline");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(search.getByRole("status")).toContainText("Could not search skills.sh");
  await expect(search.getByRole("status")).toContainText("Check the internet connection and try again.");

  // Results: name, repo, installs, and an Installed badge for one already here.
  await search.getByLabel("Search skills.sh").fill("support weekly");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(search.getByRole("status")).toHaveText("2 skills found on skills.sh.");
  const results = search.getByRole("list", { name: "Search results" });
  const support = results.locator('[data-result="acme/support-replies/support-replies"]');
  await expect(support).toContainText("support-replies");
  await expect(support).toContainText("acme/support-replies · 1,840 installs");
  const weekly = results.locator('[data-result="oneseat/starter/weekly-report"]');
  await expect(weekly).toContainText("Installed");
  await expect(weekly.getByRole("button", { name: /^Install/ })).toHaveCount(0);

  // Inspect shows the usual report and installs nothing.
  await support.getByRole("button", { name: "Inspect support-replies from skills.sh" }).click();
  const report = add.locator('[data-verdict="pass"]');
  await expect(report).toContainText("Passed the security check");
  await expect(page.getByLabel("Where is the skill?")).toHaveValue("acme/support-replies@support-replies");
  await expect(installed.locator('[data-skill="support-replies"]')).toHaveCount(0);

  // Install runs the same check first, then installs a clean pass.
  await support.getByRole("button", { name: "Install support-replies from skills.sh" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installed support-replies." })).toBeVisible();
  await expect(installed.locator('[data-skill="support-replies"]')).toBeVisible();
  await expect(support).toContainText("Installed");

  // A result with warnings waits for the person to confirm in the report.
  await search.getByLabel("Search skills.sh").fill("notes");
  await search.getByRole("button", { name: "Search" }).click();
  await results.locator('[data-result="acme/notes/warn-notes"]').getByRole("button", { name: "Install warn-notes from skills.sh" }).click();
  const warn = add.locator('[data-verdict="warn"]');
  await expect(warn).toContainText("Passed with warnings");
  await expect(warn.getByRole("button", { name: "Install warn-notes" })).toBeDisabled();
  await expect(installed.locator('[data-skill="warn-notes"]')).toHaveCount(0);
});
