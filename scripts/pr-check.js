#!/usr/bin/env node
import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function waitForFile(filePath, timeout = 5000) {
  const start = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH || "event.json";

  if (!existsSync(eventPath)) {
    console.error("event.json not found");
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(eventPath, "utf8"));
  const prNumber = payload.pull_request?.number;

  if (!prNumber) {
    console.error("No pull request number found in event.json");
    process.exit(1);
  }

  // Run lint
  console.log("Running lint...");
  const lint = await runCmd("npm run lint");
  console.log(lint.stdout);
  if (lint.stderr) console.error(lint.stderr);

  // Run tests with coverage
  console.log("Running tests with coverage...");
  const test = await runCmd("npm test -- --coverage");
  console.log(test.stdout);
  if (test.stderr) console.error(test.stderr);

  // Read coverage safely
  let coveragePct = 0;
  const covPath = join(process.cwd(), "coverage", "coverage-summary.json");
  console.log("Looking for coverage file at:", covPath);

  const fileExists = await waitForFile(covPath, 5000);
  if (fileExists) {
    try {
      const cov = JSON.parse(readFileSync(covPath, "utf8"));
      const linesPct = cov.total?.lines?.pct;
      coveragePct =
        linesPct === "Unknown"
          ? 0
          : Number(linesPct ?? cov.total?.statements?.pct ?? 0);

      console.log("Coverage percent:", coveragePct);
    } catch (err) {
      console.error("Failed to read coverage JSON:", err);
      coveragePct = 0;
    }
  } else {
    console.log(
      "Coverage file not found after waiting, skipping coverage check.",
    );
    coveragePct = 0;
  }

  // Build PR comment
  let comment = "## Automated PR Review\n\n";
  comment += lint.code === 0 ? "✅ Lint passed\n" : "❌ Lint failed\n";
  comment += test.code === 0 ? "✅ Tests passed\n" : "❌ Tests failed\n";

  if (coveragePct === 0) {
    comment += "⚠️ No source files instrumented — coverage is 0%\n";
  } else {
    comment += `📊 Coverage: ${coveragePct}%\n`;
  }

  const threshold = Number(process.env.COVERAGE_THRESHOLD ?? 80);
  if (coveragePct > 0) {
    comment +=
      coveragePct >= threshold
        ? `✅ Coverage meets threshold (${threshold}%)\n`
        : `❌ Coverage below threshold (${threshold}%)\n`;
  }

  console.log("\n=== PR Check Results ===");
  console.log(comment);
  console.log("=======================\n");

  // Check if all checks passed
  if (lint.code !== 0 || test.code !== 0 || coveragePct < threshold) {
    console.error("PR checks failed!");
    process.exit(1);
  }

  console.log("PR checks passed!");
  process.exit(0);
}

// Only run if this script is executed directly
if (require.main === module) {
  main();
}

export default { main };
