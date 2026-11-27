import { expect, test as base, type Page } from "@playwright/test";

export const TEST_KEY = "sk-ant-e2e-test-0123456789";

/** Every test starts with a fresh fake daemon, no keys and an empty data dir. */
export const test = base.extend<{ fresh: void }>({
  fresh: [
    async ({ request }, use) => {
      const r = await request.post("/__reset");
      expect(r.ok()).toBe(true);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** Go through first-run setup with a Claude key. */
export async function addKey(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByLabel("API key").fill(TEST_KEY);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Claude key saved in your keychain" })).toBeVisible();
}

/** Start a task from the Run screen. */
export async function runTask(page: Page, input: string): Promise<void> {
  await page.getByRole("link", { name: "Run" }).click();
  await expect(page.getByRole("heading", { name: "Run a task" })).toBeVisible();
  await expect(page.getByLabel("Model")).not.toHaveValue("");
  await page.getByLabel("What should OneSeat do?").fill(input);
  await page.getByRole("button", { name: /^Run( another)?$/ }).click();
}

export const output = (page: Page) => page.getByRole("region", { name: "Run output" });
