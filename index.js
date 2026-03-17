import "dotenv/config";
import express, { json, static as expressStatic } from "express";
import cors from "cors";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { Octokit } from "@octokit/rest";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/oauth/callback";

function getOctokit(token) {
  if (!token) {
    throw new Error("GitHub token is required. Please login with OAuth first.");
  }
  return new Octokit({ auth: token });
}

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
  retries = 3,
  delay = 500,
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

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

app.post("/api/generate-event", async (req, res) => {
  let eventFilePath;

  try {
    const { title, description, repositories, baseBranch, headBranch, reviewers, mergeMethod } =
      req.body;

    if (!repositories) {
      return res.status(400).json({
        success: false,
        message: "repositories are required",
      });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(401).json({ success: false, message: "Please login with GitHub first" });
    }
    const octokit = getOctokit(token);

    const sanitizedTitle = sanitizeInput(title || "Automated PR");
    const sanitizedDescription = sanitizeInput(
      description || "Created by PR Management System",
    );
    const sanitizedRepos = sanitizeInput(repositories);
    const sanitizedBaseBranch = sanitizeInput(baseBranch);
    const sanitizedHeadBranch = sanitizeInput(headBranch);
    const sanitizedReviewers = sanitizeInput(reviewers || "");
    const sanitizedMergeMethod = sanitizeInput(mergeMethod || "merge");

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
        console.log(prs, "Pull Request List");

        if (prs.length > 0) {
          pr = prs[0];
        } else {
          try {
            const { data: newPR } = await octokit.rest.pulls.create({
              owner,
              repo: repoName,
              title: sanitizedTitle,
              body: sanitizedDescription,
              head: sanitizedHeadBranch,
              base: sanitizedBaseBranch,
            });
            pr = newPR;
            created = true;

            if (sanitizedReviewers) {
              const reviewerList = sanitizedReviewers.split(",").map(r => r.trim()).filter(Boolean);
              const reviewersToAdd = [];
              const teamReviewers = [];

              for (const reviewer of reviewerList) {
                if (reviewer.includes("/")) {
                  teamReviewers.push({ team_slug: reviewer });
                } else {
                  reviewersToAdd.push(reviewer);
                }
              }

              if (reviewersToAdd.length > 0 || teamReviewers.length > 0) {
                try {
                  await octokit.rest.pulls.requestReviewers({
                    owner,
                    repo: repoName,
                    pull_number: pr.number,
                    reviewers: reviewersToAdd,
                    team_reviewers: teamReviewers,
                  });
                } catch (reviewErr) {
                  console.log("Failed to add reviewers:", reviewErr);
                }
              }
            }
          } catch (err) {
            console.log(err, "PR Create Error");

            githubResults.push({
              repo,
              error: `Failed to create PR: ${err.response?.data?.message || err.message}`,
            });
            continue;
          }
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
              merge_method: sanitizedMergeMethod,
            });
            merged = true;
          } else {
            mergeError = `Not mergeable: ${mergeablePR.mergeable_state}`;
          }
        } catch (err) {
          console.log(err, "Merge Error");

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
    const { repository } = req.body;

    if (!repository) {
      return res.status(400).json({
        success: false,
        message: "repository is required",
      });
    }

    let sanitizedRepository = sanitizeInput(repository);

    if (sanitizedRepository.startsWith("http")) {
      try {
        const url = new URL(sanitizedRepository);
        const pathParts = url.pathname.split("/").filter((part) => part);
        if (pathParts.length >= 2) {
          sanitizedRepository = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
          sanitizedRepository = sanitizedRepository.replace(/\.git$/, "");
        }
      } catch (e) {
        console.log("Error parsing repository URL:", e);
      }
    }

    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(sanitizedRepository)) {
      return res.status(400).json({
        success: false,
        message: `Invalid repository format: "${sanitizedRepository}". Expected format: owner/repo`,
      });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(401).json({ success: false, message: "Please login with GitHub first" });
    }
    const octokit = getOctokit(token);
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

app.post("/api/pr-status", async (req, res) => {
  try {
    const { repository, pullNumber } = req.body;

    if (!repository || !pullNumber) {
      return res.status(400).json({
        success: false,
        message: "repository and pullNumber are required",
      });
    }

    const sanitizedRepo = sanitizeInput(repository);
    const sanitizedPR = parseInt(pullNumber, 10);

    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(sanitizedRepo)) {
      return res.status(400).json({
        success: false,
        message: `Invalid repository format: "${sanitizedRepo}". Expected format: owner/repo`,
      });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(401).json({ success: false, message: "Please login with GitHub first" });
    }
    const octokit = getOctokit(token);
    const [owner, repo] = sanitizedRepo.split("/");

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: sanitizedPR,
    });

    const [{ data: commits }, { data: checks }] = await Promise.all([
      octokit.rest.pulls.listCommits({ owner, repo, pull_number: sanitizedPR, per_page: 1 }),
      octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: pr.head.sha,
        per_page: 100,
      }),
    ]);

    const lastCommitSha = commits[0]?.sha;

    let status = null;
    let checksStatus = null;

    if (lastCommitSha) {
      const { data: combinedStatus } = await octokit.rest.repos.getCommitStatus({
        owner,
        repo,
        ref: lastCommitSha,
      });
      status = combinedStatus;
    }

    if (checks.check_runs.length > 0) {
      const allPassed = checks.check_runs.every(check => check.conclusion === "success");
      const hasFailure = checks.check_runs.some(check => check.conclusion === "failure");
      checksStatus = {
        total: checks.check_runs.length,
        passed: checks.check_runs.filter(c => c.conclusion === "success").length,
        failed: checks.check_runs.filter(c => c.conclusion === "failure").length,
        pending: checks.check_runs.filter(c => c.status === "queued" || c.status === "in_progress").length,
        status: hasFailure ? "failure" : allPassed ? "success" : "pending",
        runs: checks.check_runs.map(c => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          url: c.html_url,
        })),
      };
    }

    res.json({
      success: true,
      repository: sanitizedRepo,
      pullRequest: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        merged: pr.merged,
        url: pr.html_url,
      },
      commitStatus: status,
      checks: checksStatus,
    });
  } catch (error) {
    console.error("Error fetching PR status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch PR status",
      error: error.message,
    });
  }
});

app.post("/api/branches", async (req, res) => {
  try {
    const { repository } = req.body;

    if (!repository) {
      return res.status(400).json({
        success: false,
        message: "repository is required",
      });
    }

    const sanitizedRepo = sanitizeInput(repository);

    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(sanitizedRepo)) {
      return res.status(400).json({
        success: false,
        message: `Invalid repository format: "${sanitizedRepo}". Expected format: owner/repo`,
      });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(401).json({ success: false, message: "Please login with GitHub first" });
    }
    const octokit = getOctokit(token);
    const [owner, repo] = sanitizedRepo.split("/");

    const { data: branches } = await octokit.rest.repos.listBranches({
      owner,
      repo,
      per_page: 100,
    });

    const { data: defaultBranch } = await octokit.rest.repos.get({
      owner,
      repo,
    });

    res.json({
      success: true,
      repository: sanitizedRepo,
      defaultBranch: defaultBranch.default_branch,
      branches: branches.map(b => ({
        name: b.name,
        protected: b.protected,
        sha: b.commit.sha,
      })),
    });
  } catch (error) {
    console.error("Error fetching branches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch branches",
      error: error.message,
    });
  }
});

app.get("/oauth/login", (req, res) => {
  const clientId = GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ success: false, message: "GitHub OAuth not configured" });
  }
  const scope = "repo,user";
  const redirectUri = encodeURIComponent(REDIRECT_URI);
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}`);
});

app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.send("<h1>Error: No code provided</h1><a href='/'>Go back</a>");
  }

  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.send(`<h1>Error: ${data.error_description}</h1><a href='/'>Go back</a>`);
    }

    const token = data.access_token;
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Login Successful</title>
          <script>
            window.opener.postMessage({ type: 'github_token', token: '${token}' }, '*');
            setTimeout(() => window.close(), 500);
          </script>
        </head>
        <body>
          <h1>Login Successful! You can close this window.</h1>
          <p>If it doesn't close automatically, <a href="/">click here</a>.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.send(`<h1>Error: ${err.message}</h1><a href='/'>Go back</a>`);
  }
});

app.get("/oauth/status", (req, res) => {
  const hasToken = !!GITHUB_CLIENT_ID && !!GITHUB_CLIENT_SECRET;
  res.json({ configured: hasToken });
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
