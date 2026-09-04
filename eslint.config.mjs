import antfu from "@antfu/eslint-config";

export default antfu({
  type: "app",
  typescript: true,
  formatters: true,
  stylistic: {
    indent: 2,
    semi: true,
    quotes: "double",
  },
  // CLAUDE.md is the project spec, not source. `formatters: true` runs
  // prettier over markdown, which would repad every table in it — a large
  // whitespace diff over a document whose value is that it reads as prose.
  ignores: ["**/migrations/*", "CLAUDE.md"],
}, {
  rules: {
    "no-console": ["warn"],
    "antfu/no-top-level-await": ["off"],
    "node/prefer-global/process": ["off"],
    "node/no-process-env": ["error"],
    "perfectionist/sort-imports": ["error", {
      tsconfigRootDir: ".",
    }],
    "unicorn/filename-case": ["error", {
      case: "kebabCase",
      // CLAUDE.md and LICENSE are fixed filenames set by their tooling.
      ignore: ["README.md", "CLAUDE.md", "LICENSE"],
    }],
  },
});
