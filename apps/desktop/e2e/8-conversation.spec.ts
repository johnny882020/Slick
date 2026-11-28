// Flow 8 (pilot feedback): a skill's follow-up questions can be answered. A question mid-run
// is answered in the transcript; a finished run takes a reply in the same session; and a
// result can be turned into an app that pins.
import { addKey, expect, runTask, test } from "./fixtures";

test("answer a question with the keyboard, reply in the same session, then turn it into an app", async ({ page }) => {
  await addKey(page);
  await runTask(page, "Write the monthly report, but ask me which month");
  const conversation = page.getByRole("region", { name: "Conversation" });

  // The question card takes focus; its options are reachable with Tab and Enter.
  const card = conversation.getByRole("group", { name: "Which month should the report cover?" });
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(conversation.getByRole("status").first()).toHaveText("Waiting for your answer");
  await expect(card.getByRole("button", { name: "October" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "October" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "November" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card).toContainText("You answered: November");
  await expect(card.getByRole("button", { name: "November" })).toBeHidden();

  const first = conversation.getByRole("region", { name: "Run output" }).first();
  await expect(first.getByText("Done", { exact: true })).toBeVisible();
  await expect(first).toContainText("November report: revenue was $48,200");
  // The ask_user call shows as the card, not as a tool row.
  await expect(first.locator('[data-tool="ask_user"]')).toHaveCount(0);

  // Reply: the skill ended with a question of its own, and the person answers it.
  const reply = page.getByLabel("Reply", { exact: true });
  await expect(reply).toBeVisible();
  await reply.fill("Make it shorter");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const outputs = conversation.getByRole("region", { name: "Run output" });
  await expect(outputs).toHaveCount(2);
  await expect(conversation.locator(".turn-text")).toHaveText(["Write the monthly report, but ask me which month", "Make it shorter"]);
  const second = outputs.nth(1);
  await expect(second).toContainText("You said “Make it shorter”");
  await expect(second).toContainText("Turn 2 of this conversation");
  await expect(second.getByText("Done", { exact: true })).toBeVisible();
  await expect(reply).toHaveValue("");

  // Turn into app: brand-kit makes a pin-able draft from the result, in the same conversation.
  await page.getByRole("button", { name: "Turn into app" }).click();
  await expect(outputs).toHaveCount(3);
  const third = outputs.nth(2);
  await expect(third.locator('[data-skill="brand-kit"]')).toHaveAttribute("title", "Chosen by you");
  const draft = third.locator('[data-draft="weekly-summary"]');
  await expect(draft).toContainText("Weekly summary");
  await expect(draft).toContainText("Can run: weekly-report");
  // A run that made an app does not offer it again.
  await expect(page.getByRole("button", { name: "Turn into app" })).toBeHidden();
  await draft.getByRole("button", { name: "Pin as app" }).click();
  await expect(draft).toContainText("Pinned. Find it under Apps.");
  await page.getByRole("link", { name: "Apps" }).click();
  await expect(page.getByRole("region", { name: "Pinned apps" }).locator('[data-app="weekly-summary"]')).toContainText("Weekly summary");

  // One row per conversation in Recent runs, and New task starts fresh.
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await expect(conversation).toBeHidden();
  await expect(page.getByLabel("What should OneSeat do?")).toBeFocused();
  await expect(page.getByLabel("What should OneSeat do?")).toHaveValue("");
});

test("a typed answer or a skip, and a cancelled question closes", async ({ page }) => {
  await addKey(page);
  await runTask(page, "ask me which month for the report");
  const conversation = page.getByRole("region", { name: "Conversation" });
  const card = conversation.getByRole("group", { name: "Which month should the report cover?" });
  await card.getByLabel("Or type your own answer").fill("The whole quarter");
  await card.getByRole("button", { name: "Send answer" }).click();
  await expect(card).toContainText("You answered: The whole quarter");
  await expect(conversation).toContainText("The whole quarter report");

  await runTask(page, "ask again please");
  const skipCard = page.getByRole("region", { name: "Conversation" }).getByRole("group", { name: "Which month should the report cover?" });
  await skipCard.getByRole("button", { name: "Skip" }).click();
  await expect(skipCard).toContainText("You skipped this question.");
  await expect(page.getByRole("region", { name: "Conversation" })).toContainText("You skipped the question, so I used last month.");

  await runTask(page, "ask and then I will cancel");
  const pending = page.getByRole("region", { name: "Conversation" }).getByRole("group", { name: "Which month should the report cover?" });
  await expect(pending).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(pending).toContainText("The run ended before this was answered.");
  await expect(page.getByRole("region", { name: "Run output" }).getByRole("status").first()).toHaveText("Cancelled");
});
