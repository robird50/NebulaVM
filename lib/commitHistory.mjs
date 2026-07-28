const GITHUB_COMMITS_URL =
  "https://api.github.com/repos/robird50/NebulaVM/commits";
const NETLIFY_DEPLOYS_URL =
  "https://api.netlify.com/api/v1/sites/cd0408e6-bb4d-4b7a-b46f-80275eac7b77/deploys";
const NETLIFY_SITE_NAME = "nebulavm";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const fetchPages = async (fetchImpl, baseUrl, headers = {}) => {
  const records = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    const response = await fetchImpl(
      `${baseUrl}${separator}per_page=${PAGE_SIZE}&page=${page}`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`Commit history service returned HTTP ${response.status}.`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) {
      throw new Error("Commit history service returned an invalid response.");
    }
    records.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return records;
};

const validSha = (value) => /^[a-f0-9]{40}$/i.test(String(value || ""));
const validDeployId = (value) => /^[a-f0-9]{24}$/i.test(String(value || ""));

export const buildCommitHistory = (githubCommits, netlifyDeploys) => {
  const deployByCommit = new Map();
  for (const deploy of netlifyDeploys) {
    const sha = String(deploy?.commit_ref || "").toLowerCase();
    if (
      deploy?.state !== "ready" ||
      !validSha(sha) ||
      !validDeployId(deploy?.id) ||
      deployByCommit.has(sha)
    ) {
      continue;
    }
    deployByCommit.set(sha, deploy);
  }

  const commits = githubCommits
    .filter((commit) => validSha(commit?.sha))
    .map((commit) => {
      const sha = String(commit.sha).toLowerCase();
      const deploy = deployByCommit.get(sha);
      const message = String(commit?.commit?.message || "Untitled commit")
        .split(/\r?\n/)[0]
        .trim()
        .slice(0, 180);
      const authoredAt = String(
        commit?.commit?.author?.date || commit?.commit?.committer?.date || "",
      );
      return {
        sha,
        shortSha: sha.slice(0, 7),
        message,
        authoredAt,
        available: Boolean(deploy),
        deployUrl: deploy
          ? `https://${deploy.id}--${NETLIFY_SITE_NAME}.netlify.app/`
          : null,
      };
    });

  const latestWorkingIndex = commits.findIndex((commit) => commit.available);
  if (latestWorkingIndex >= 0) {
    commits[latestWorkingIndex].latestWorking = true;
  }
  return commits;
};

export const getCommitHistory = async (fetchImpl = fetch) => {
  const [githubCommits, netlifyDeploys] = await Promise.all([
    fetchPages(fetchImpl, GITHUB_COMMITS_URL, {
      Accept: "application/vnd.github+json",
      "User-Agent": "NebulaVM-Commit-History",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    fetchPages(fetchImpl, NETLIFY_DEPLOYS_URL),
  ]);
  return buildCommitHistory(githubCommits, netlifyDeploys);
};

