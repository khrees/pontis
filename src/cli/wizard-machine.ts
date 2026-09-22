import { t, SYM } from "./ui";
import type { ProviderType } from "./preferences";
import type { ClientName } from "./install-engine";
import type { PontisEnv } from "./config";

export type WizardStepId =
  | "resume"
  | "provider"
  | "credentials"
  | "category"
  | "model"
  | "client"
  | "review";

export type StepAction =
  | { type: "next"; patch?: Partial<WizardContext> }
  | { type: "back" }
  | { type: "jump"; stepId: WizardStepId; patch?: Partial<WizardContext> }
  | { type: "cancel" };

export interface WizardContext {
  provider?: ProviderType;
  upstreamUrl?: string;
  upstreamFormat?: string;
  apiKey?: string;
  accountId?: string;
  gatewayId?: string;
  category?: "free" | "frontier" | "chinese" | "others";
  model?: string;
  client?: ClientName | "server";
  env: PontisEnv;
  availableModels?: string[];
  lastUsed?: { client?: string; provider?: ProviderType; model?: string };
  launchDirectly?: boolean;
}

export interface WizardStepDefinition {
  id: WizardStepId;
  title: string;
  canSkip?: (ctx: WizardContext) => boolean;
  run: (ctx: WizardContext) => Promise<StepAction>;
}

export class WizardStateMachine {
  private history: WizardStepId[] = [];
  private steps: Map<WizardStepId, WizardStepDefinition> = new Map();
  private stepOrder: WizardStepId[] = [];
  private context: WizardContext;

  constructor(initialContext: WizardContext, stepDefs: WizardStepDefinition[]) {
    this.context = { ...initialContext };
    for (const s of stepDefs) {
      this.steps.set(s.id, s);
      this.stepOrder.push(s.id);
    }
  }

  getContext(): WizardContext {
    return this.context;
  }

  getHistory(): WizardStepId[] {
    return [...this.history];
  }

  getNextStepId(currentId: WizardStepId): WizardStepId | null {
    const idx = this.stepOrder.indexOf(currentId);
    if (idx >= 0 && idx + 1 < this.stepOrder.length) {
      return this.stepOrder[idx + 1];
    }
    return null;
  }

  renderBreadcrumbs(currentId: WizardStepId) {
    const visibleSteps = this.stepOrder.filter((id) => id !== "resume");
    const currentIdx = (visibleSteps as WizardStepId[]).indexOf(currentId);
    if (currentIdx < 0) return;

    const total = visibleSteps.length;
    const stepNum = currentIdx + 1;

    const formatLabel = (id: WizardStepId): string => {
      switch (id) {
        case "provider":
          return this.context.provider ? `Provider: ${this.context.provider}` : "Provider";
        case "credentials":
          return "Auth";
        case "category":
          return this.context.category ? `Category: ${this.context.category}` : "Category";
        case "model":
          return this.context.model ? `Model: ${this.context.model}` : "Model";
        case "client":
          return this.context.client ? `Client: ${this.context.client}` : "Client";
        case "review":
          return "Review";
        default:
          return id;
      }
    };

    const breadcrumbs = visibleSteps
      .map((id, i) => {
        const text = formatLabel(id);
        if (i < currentIdx) {
          return t.success(text);
        } else if (i === currentIdx) {
          return t.bold(t.primary(`[${text}]`));
        } else {
          return t.dim(text);
        }
      })
      .join(t.muted(" ➔ "));

    console.log(
      `\n  ${t.primary(SYM.bullet)} ${t.bold("Pontis Setup Wizard")}  ${t.muted(`Step ${stepNum} of ${total}`)}`,
    );
    console.log(`  ${breadcrumbs}`);
    console.log(`  ${t.dim("─".repeat(60))}`);
  }

  async run(startStepId: WizardStepId = "resume"): Promise<WizardContext | null> {
    let currentId: WizardStepId | null = startStepId;

    while (currentId) {
      const step = this.steps.get(currentId);
      if (!step) break;

      // Skip steps if already satisfied or marked skip
      if (step.canSkip && step.canSkip(this.context)) {
        currentId = this.getNextStepId(currentId);
        continue;
      }

      this.renderBreadcrumbs(currentId);
      const action = await step.run(this.context);

      switch (action.type) {
        case "next":
          if (action.patch) {
            Object.assign(this.context, action.patch);
          }
          this.history.push(currentId);
          currentId = this.getNextStepId(currentId);
          break;

        case "back": {
          const prev = this.history.pop();
          if (!prev) {
            return null; // Exited at first step
          }
          currentId = prev;
          break;
        }

        case "jump":
          if (action.patch) {
            Object.assign(this.context, action.patch);
          }
          this.history.push(currentId);
          currentId = action.stepId;
          break;

        case "cancel":
          return null;
      }
    }

    return this.context;
  }
}
