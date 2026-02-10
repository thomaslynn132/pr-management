document.addEventListener("DOMContentLoaded", () => {
  function setResult(html) {
    resultContent.style.opacity = "0";
    setTimeout(() => {
      resultContent.innerHTML = html;
      resultContent.style.opacity = "1";
    }, 120);
  }

  function renderGenerateResult(data) {
    if (!data.success) {
      return setResult(`
      <div class="result-item error">
        <h3>❌ Error</h3>
        <p>${sanitizeHTML(data.message || "Something went wrong")}</p>
      </div>
    `);
    }

    const results = data.githubPR?.results || [];

    if (!results.length) {
      return setResult(`
      <div class="result-item warning">
        <p>No PR actions were performed.</p>
      </div>
    `);
    }

    let html = "";

    results.forEach((item) => {
      if (item.error) {
        html += `
        <div class="result-item error">
          <h3>❌ ${sanitizeHTML(item.repo)}</h3>
          <p>${sanitizeHTML(item.error)}</p>
        </div>
      `;
      } else {
        html += `
        <div class="result-item success">
          <h3>✅ ${sanitizeHTML(item.repo)}</h3>
          <p>PR processed successfully</p>
          ${
            item.url
              ? `<a href="${sanitizeHTML(item.url)}" target="_blank">View PR →</a>`
              : ""
          }
        </div>
      `;
      }
    });

    setResult(html);
  }

  const generateButton = document.getElementById("generate-event");
  const checkPrsButton = document.getElementById("check-prs");
  const resultContent = document.getElementById("result-content");

  setupRealTimeValidation();

  function sanitizeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function validateForm() {
    let valid = true;
    ["github-token", "repositories"].forEach((id) => {
      const field = document.getElementById(id);
      field.style.borderColor = "#ddd";
      if (!field.value.trim()) {
        field.style.borderColor = "#dc3545";
        valid = false;
      }
    });
    return valid;
  }

  function setupRealTimeValidation() {
    ["github-token", "repositories"].forEach((id) => {
      const field = document.getElementById(id);
      field.addEventListener("input", () => {
        field.style.borderColor = "#ddd";
      });
    });
  }

  function displayError(message, error) {
    resultContent.innerHTML = `
      <div class="result-item error">
        <h3>❌ Error</h3>
        <p>${sanitizeHTML(message)}</p>
        ${error ? `<pre>${sanitizeHTML(error)}</pre>` : ""}
      </div>
    `;
  }

  generateButton.addEventListener("click", async () => {
    if (!validateForm()) {
      displayError("Please fill in all required fields.");
      return;
    }

    generateButton.classList.add("btn-loading");
    generateButton.disabled = true;

    try {
      const response = await fetch("/api/generate-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: document.getElementById("pr-title").value || "Automated PR",
          description:
            document.getElementById("pr-description").value ||
            "Created by PR Management System",
          token: document.getElementById("github-token").value,
          repositories: document.getElementById("repositories").value,
          baseBranch: document.getElementById("base-branch").value || "main",
          headBranch:
            document.getElementById("head-branch").value || "feature-branch",
        }),
      });

      const data = await response.json();
      renderGenerateResult(data);
    } catch (err) {
      displayError("Failed to connect to server", err.message);
    } finally {
      generateButton.classList.remove("btn-loading");
      generateButton.disabled = false;
    }
  });

  checkPrsButton.addEventListener("click", async () => {
    if (!validateForm()) {
      displayError("Please fill in all required fields.");
      return;
    }

    checkPrsButton.classList.add("btn-loading");
    checkPrsButton.disabled = true;

    try {
      const repo = document
        .getElementById("repositories")
        .value.split(",")[0]
        .trim();

      const response = await fetch("/api/check-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: document.getElementById("github-token").value,
          repository: repo,
        }),
      });

      const data = await response.json();
      renderGenerateResult(data);
    } catch (err) {
      displayError("Failed to connect to server", err.message);
    } finally {
      checkPrsButton.classList.remove("btn-loading");
      checkPrsButton.disabled = false;
    }
  });
});
