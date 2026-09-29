export const sampleInput = {
  v: 1 as const,
  url: "https://recipes.example.com/tomato-soup",
  title: "Tomato soup – Recipes",
  sentAt: "2026-09-24T15:32:00.000Z",
  target: { agent: "claude" as const, sessionId: "s-1", cwd: "/tmp/repo" },
  overall: "can we make this vegan?",
  annotations: [{
    id: "A1", kind: "text" as const, comment: "is there a substitute for cream?", intent: "question" as const,
    anchor: { quote: { exact: "200 ml cream", prefix: "stir in ", suffix: " before serving" },
              css: "section#ingredients > li:nth-child(3)", path: ["main", "section#ingredients", "ul"], near: "Ingredients" },
    box: { x: 10, y: 20, w: 100, h: 18 },
    viewport: { w: 1280, h: 800, dpr: 2, scrollY: 0 },
    crop: "crops/A1.png",
  }],
};
