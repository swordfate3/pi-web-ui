import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatLifecycleResponses from "./responses/chat-lifecycle.ts";
import collapseRegressionResponses from "./responses/collapse-regression.ts";
import dailyCommandsResponses from "./responses/daily-commands.ts";
import duplicateArtifactResponses from "./responses/duplicate-artifact.ts";
import externalArtifactResponses from "./responses/external-artifact.ts";
import languageMarkdownResponses from "./responses/language-markdown.ts";
import largeToolOutputResponses from "./responses/large-tool-output.ts";
import toolFailureResponses from "./responses/tool-failure.ts";
import workspaceArtifactResponses from "./responses/workspace-artifact.ts";

const responsesByName = {
  "chat-lifecycle": chatLifecycleResponses,
  "collapse-regression": collapseRegressionResponses,
  "daily-commands": dailyCommandsResponses,
  "language-markdown": languageMarkdownResponses,
  "large-tool-output": largeToolOutputResponses,
  "slash-commands": chatLifecycleResponses,
  "duplicate-artifact": duplicateArtifactResponses,
  "external-artifact": externalArtifactResponses,
  "tool-failure": toolFailureResponses,
  "workspace-artifact": workspaceArtifactResponses,
};

function fixtureForChunking() {
  return process.env.PI_WEB_UI_E2E_FIXTURE;
}

export default function (pi: ExtensionAPI) {
  const faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", name: "Faux E2E", reasoning: true }],
    // Large tool arguments are transport fixtures, not token-by-token stress.
    // Keep baseline and optimized runs on the same deterministic chunk size.
    tokenSize: fixtureForChunking() === "large-tool-output" ? { min: 8192, max: 8192 } : { min: 64, max: 64 },
  });
  const model = faux.getModel();
  const fixtureName = process.env.PI_WEB_UI_E2E_FIXTURE || "chat-lifecycle";
  const responses = responsesByName[fixtureName as keyof typeof responsesByName] || chatLifecycleResponses;

  faux.setResponses(responses);
  pi.registerProvider("faux", {
    name: "Faux E2E",
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api as never,
    models: faux.models.map((registeredModel) => ({
      id: registeredModel.id,
      name: registeredModel.name,
      api: registeredModel.api as never,
      reasoning: registeredModel.reasoning,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      input: registeredModel.input,
      cost: registeredModel.cost,
      contextWindow: fixtureForChunking() === "large-tool-output" ? 4_000_000 : registeredModel.contextWindow,
      maxTokens: registeredModel.maxTokens,
      baseUrl: registeredModel.baseUrl,
    })),
  });

  pi.on("session_shutdown", () => {
    faux.unregister();
    pi.unregisterProvider("faux");
  });
}
