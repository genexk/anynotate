// Runtime assets, imported statically so a compiled binary carries them.
import skill from "../../assets/skill/SKILL.md" with { type: "text" };
import geminiCommand from "../../assets/gemini/annotations.toml" with { type: "text" };
import extensionIds from "../../assets/extension-ids.json";

export const EMBEDDED_ASSETS: Readonly<Record<string, string>> = {
  "assets/skill/SKILL.md": skill,
  "assets/gemini/annotations.toml": geminiCommand,
  "assets/extension-ids.json": JSON.stringify(extensionIds),
};
