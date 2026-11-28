import type { Api } from "../api";
import type { Store } from "../store";

export type Route = "setup" | "run" | "skills" | "apps" | "schedules" | "activity" | "plan";

export const ROUTES: { id: Route; label: string }[] = [
  { id: "run", label: "Run" },
  { id: "skills", label: "Skills" },
  { id: "apps", label: "Apps" },
  { id: "schedules", label: "Schedules" },
  { id: "activity", label: "Activity" },
  { id: "setup", label: "Model keys" },
  { id: "plan", label: "Plan" },
];

export interface Ctx {
  api: Api;
  store: Store;
  navigate(route: Route): void;
  /** Short status message in the shared live region (and a toast). */
  notify(message: string, kind?: "info" | "error"): void;
  /** Open the approval dialog for this approval id. */
  reviewApproval(approvalId: string): void;
}

export interface View {
  readonly el: HTMLElement;
  /** Called each time the view becomes visible. */
  show(): void;
}
