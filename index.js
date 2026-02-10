import express, { json, static as expressStatic } from "express";
import cors from "cors";
// import { exec } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { Octokit } from "@octokit/rest";
import { fileURLToPath } from "url";
import { log } from "console";

const app = express();
const PORT = process.env.PORT || 3000;

// Get the directory name for security
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Middleware
app.use(
  cors({
    origin: process.env.NODE_ENV === "production" ? false : "*",
    credentials: true,
  }),
);
app.use(json({ limit: "10mb" }));
app.use(expressStatic(join(__dirname, ".")));
function sanitizeInput(input) {
  if (typeof input !== "string") return "";
  return input;
}

async function waitForMergeable(
  octokit,
  owner,
  repo,
  pull_number,
  retries = 10,
  delay = 1500,
) {
  for (let i = 0; i < retries; i++) {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number,
    });

    if (pr.mergeable !== null) {
      return pr;
    }

    await new Promise((r) => setTimeout(r, delay));
  }

  throw new Error("Timed out waiting for github to compute mergeability");
}

app.post("/api/generate-event", async (req, res) => {
  let eventFilePath;

  try {
    const {
      title,
      description,
      token,
      repositories,
      baseBranch = "main",
      headBranch = "thomas",
    } = req.body;

    if (!token || !repositories) {
      return res.status(400).json({
        success: false,
        message: "github token and repositories are required",
      });
    }

    const sanitizedTitle = sanitizeInput(title || "Automated PR");
    const sanitizedDescription = sanitizeInput(
      description || "Created by PR Management System",
    );
    const sanitizedRepos = sanitizeInput(repositories);
    const sanitizedBaseBranch = sanitizeInput(baseBranch);
    const sanitizedHeadBranch = sanitizeInput(headBranch);

    if (sanitizedBaseBranch === sanitizedHeadBranch) {
      return res.status(400).json({
        success: false,
        message: "Base and head branch cannot be the same",
      });
    }

    const reposArray = sanitizedRepos
      .split(",")
      .map((repo) => repo.trim())
      .filter(Boolean);

    if (reposArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one repository is required",
      });
    }

    for (const repo of reposArray) {
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
        return res.status(400).json({
          success: false,
          message: `Invalid repository format: ${repo}`,
        });
      }
    }
    const mockEvent = {
      pull_request: {
        number: Math.floor(Math.random() * 1000) + 1,
        title: sanitizedTitle,
        body: sanitizedDescription,
        head: { ref: sanitizedHeadBranch },
        base: { ref: sanitizedBaseBranch },
      },
    };

    eventFilePath = join(process.cwd(), "temp_event.json");
    writeFileSync(eventFilePath, JSON.stringify(mockEvent, null, 2));

    const octokit = new Octokit({ auth: token });

    const result = {
      success: true,
      githubPR: { results: [] },
    };

    const githubResults = [];

    for (const repo of reposArray) {
      const [owner, repoName] = repo.split("/");

      try {
        await octokit.rest.repos.getBranch({
          owner,
          repo: repoName,
          branch: sanitizedBaseBranch,
        });

        await octokit.rest.repos.getBranch({
          owner,
          repo: repoName,
          branch: sanitizedHeadBranch,
        });
        const { data: prs } = await octokit.rest.pulls.list({
          owner,
          repo: repoName,
          state: "open",
          base: sanitizedBaseBranch,
          head: `${owner}:${sanitizedHeadBranch}`,
        });

        let pr;
        let created = false;

        if (prs.length > 0) {
          pr = prs[0];
        } else {
          const { data } = await octokit.rest.pulls.create({
            owner,
            repo: repoName,
            title: sanitizedTitle,
            body: sanitizedDescription,
            head: sanitizedHeadBranch,
            base: sanitizedBaseBranch,
          });
          pr = data;
          created = true;
        }
        let merged = false;
        let mergeError = null;

        try {
          const mergeablePR = await waitForMergeable(
            octokit,
            owner,
            repoName,
            pr.number,
          );

          if (
            mergeablePR.mergeable &&
            mergeablePR.mergeable_state === "clean"
          ) {
            await octokit.rest.pulls.merge({
              owner,
              repo: repoName,
              pull_number: pr.number,
              merge_method: "merge",
            });
            merged = true;
          } else {
            mergeError = `Not mergeable: ${mergeablePR.mergeable_state}`;
          }
        } catch (err) {
          mergeError = err.message;
        }

        githubResults.push({
          repo,
          prNumber: pr.number,
          url: pr.html_url,
          created,
          merged,
          mergeError,
        });
      } catch (err) {
        githubResults.push({
          repo,
          error: err.response?.data?.message || err.message,
        });
      }
    }

    result.githubPR = { results: githubResults };

    res.json(result);
  } catch (error) {
    console.error("generate-event error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    try {
      if (eventFilePath && existsSync(eventFilePath)) {
        unlinkSync(eventFilePath);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  }
});

app.post("/api/check-pr", async (req, res) => {
  try {
    const { token, repository } = req.body;

    if (!token || !repository) {
      return res.status(400).json({
        success: false,
        message: "github token, and repository are required",
      });
    }

    let sanitizedRepository = sanitizeInput(repository);

    // If it looks like a URL, extract owner/repo
    if (sanitizedRepository.startsWith("http")) {
      try {
        const url = new URL(sanitizedRepository);
        // Extract path parts, removing empty first element from split('/')
        const pathParts = url.pathname.split("/").filter((part) => part);
        if (pathParts.length >= 2) {
          // Take the last two parts to get owner/repo (handles cases like /user/repo.git)
          sanitizedRepository = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
          // Remove .git suffix if present
          sanitizedRepository = sanitizedRepository.replace(/\.git$/, "");
        }
      } catch (e) {
        log("Error parsing repository URL:", e);
        // If URL parsing fails, leave as is and validation will catch it
      }
    }

    // Validate repository format
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(sanitizedRepository)) {
      return res.status(400).json({
        success: false,
        message: `Invalid repository format: "${sanitizedRepository}". Expected format: owner/repo`,
      });
    }
    const octokit = new Octokit({ auth: token });
    const [owner, repo] = sanitizedRepository.split("/");

    // Get open PRs
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
    });
    console.log("sani repo", sanitizedRepository);
    res.json({
      success: true,
      repository: sanitizedRepository,
      pullRequests: prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        user: pr.user.login,
        createdAt: pr.created_at,
      })),
    });
  } catch (error) {
    console.error("Error checking PRs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch PRs",
      error: error.message,
    });
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`PR Management System running at http://localhost:${PORT}`);
});
server.setTimeout(5 * 60 * 1000); // 5 minutes

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => {
    console.log("Process terminated");
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  server.close(() => {
    console.log("Process terminated");
  });
});
