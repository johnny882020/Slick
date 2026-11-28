// Flow 4: add a skill. Inspect first (plain-English summary, findings, lint), block verdicts
// cannot be installed, a pass installs after the person confirms.
import { addKey, expect, test } from "./fixtures";

test("inspect, block, pass, install and remove", async ({ page }) => {
  await addKey(page);
  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page.getByRole("heading", { name: "Skill library" })).toBeVisible();
  const installed = page.getByRole("region", { name: "Installed skills" });
  await expect(installed.locator('[data-skill="invoice-chaser"]')).toBeVisible();
  await expect(installed.locator('[data-skill="weekly-report"]')).toBeVisible();

  const source = page.getByLabel("Where is the skill?");
  const add = page.getByRole("form", { name: "Add a skill" });

  // 1. A blocked skill: summary + findings, and no way to install.
  await source.fill("https://github.com/bad-actor/evil-exfil");
  await expect(add).toContainText("From GitHub bad-actor/evil-exfil");
  await page.getByRole("button", { name: "Check skill" }).click();
  const blocked = add.locator('[data-verdict="block"]');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText("Blocked by the security check");
  await expect(blocked).toContainText("uploads it to a web address it does not declare");
  await expect(blocked).toContainText('Script contacts "paste.example.net"');
  await expect(blocked).toContainText("scripts/sync.ts:14");
  await expect(blocked.getByRole("alert")).toHaveText("Blocked skills cannot be installed.");
  await expect(blocked.getByRole("button", { name: /^Install/ })).toHaveCount(0);
  await blocked.getByRole("button", { name: "Cancel" }).click();
  await expect(blocked).toHaveCount(0);

  // 2. A warning: install needs an explicit confirmation.
  await source.fill("./skills/warn-notes");
  await page.getByRole("button", { name: "Check skill" }).click();
  const warn = add.locator('[data-verdict="warn"]');
  await expect(warn).toContainText("Passed with warnings");
  await expect(warn).toContainText("description should say when to use the skill");
  const installWarn = warn.getByRole("button", { name: "Install warn-notes" });
  await expect(installWarn).toBeDisabled();
  await warn.getByLabel("I have read the warnings and want to install this skill.").check();
  await expect(installWarn).toBeEnabled();
  await warn.getByRole("button", { name: "Cancel" }).click();

  // 3. A pass: summary shown, nothing installed until the person clicks Install.
  await source.fill("acme/support-replies");
  await expect(add).toContainText("From skills.sh acme/support-replies");
  await page.getByRole("button", { name: "Check skill" }).click();
  const pass = add.locator('[data-verdict="pass"]');
  await expect(pass).toContainText("Passed the security check");
  await expect(pass).toContainText("drafts replies to customer support tickets");
  await expect(pass).toContainText("It asks for no internet, file or program access.");
  await expect(pass).toContainText("Format check: no issues.");
  await expect(installed.locator('[data-skill="support-replies"]')).toHaveCount(0);
  await pass.getByRole("button", { name: "Install support-replies" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installed support-replies." })).toBeVisible();
  await expect(installed.locator('[data-skill="support-replies"]')).toBeVisible();
  await expect(source).toHaveValue("");

  // Remove asks for a second click.
  const card = installed.locator('[data-skill="support-replies"]');
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await card.getByRole("button", { name: "Remove support-replies" }).click();
  await expect(installed.locator('[data-skill="support-replies"]')).toHaveCount(0);

  // A source that does not exist reports an error.
  await source.fill("missing/thing");
  await page.getByRole("button", { name: "Check skill" }).click();
  await expect(add.getByRole("status")).toContainText("Could not check the skill: no skill found");
});
