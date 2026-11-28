// Flow 1: first-run key setup.
import { addKey, expect, test, TEST_KEY } from "./fixtures";

test("first run asks for a key, saves it, and shows its status", async ({ page }) => {
  await page.goto("/");
  // First run lands on setup.
  await expect(page).toHaveURL(/#\/setup$/);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await expect(page.getByText("stored in your operating system's keychain")).toBeVisible();
  // The setup text has no links.
  await expect(page.locator("main a")).toHaveCount(0);

  // Provider choice changes the form: Local asks for a server address.
  const providers = page.getByRole("group", { name: "Model provider" });
  for (const name of ["Claude", "OpenAI", "Gemini", "Local"]) await expect(providers.getByLabel(name, { exact: true })).toBeVisible();
  await providers.getByLabel("Local", { exact: true }).check();
  await expect(page.getByLabel("Server address (base URL)")).toBeVisible();
  await providers.getByLabel("Claude", { exact: true }).check();
  await expect(page.getByLabel("Server address (base URL)")).toBeHidden();

  // A bad key is refused with a reason that does not repeat it.
  await page.getByLabel("API key").fill("abc");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "too short" })).toBeVisible();

  await addKey(page);
  // The key is gone from the page once saved.
  await expect(page.getByLabel("API key")).toHaveValue("");
  expect(await page.content()).not.toContain(TEST_KEY);
  const row = page.locator('tr[data-provider="anthropic"]');
  await expect(row).toContainText("Saved");
  await expect(row).toContainText("Ready");
  await expect(page.locator('tr[data-provider="openai"]')).toContainText("No key");

  // Continue to Run; the provider is now available there.
  await page.getByRole("button", { name: "Continue to Run" }).click();
  await expect(page).toHaveURL(/#\/run$/);
  await expect(page.getByLabel("Provider")).toHaveValue("anthropic");
  await expect(page.getByLabel("Model")).toHaveValue("claude-opus-5-5");

  // After a reload the app opens on Run (a key exists), not on setup.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Run a task" })).toBeVisible();

  // Removing the key returns the provider to "No key".
  await page.getByRole("link", { name: "Model keys" }).click();
  await page.getByRole("button", { name: "Remove the Claude key" }).click();
  await expect(page.locator('tr[data-provider="anthropic"]')).toContainText("No key");
});
