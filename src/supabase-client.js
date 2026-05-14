#!/usr/bin/env node
// Minimal Supabase REST client for CD Sync Watcher — no SDK dependency
const https = require("https");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = "https://kjmcpvecywgjhvihrert.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ltt47EBgS0L6RsMPuJxLgQ_gyuiMMQF";

function getGitEmail() {
  try {
    return execSync("git config user.email", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function supabaseRequest(method, table, body, query) {
  return new Promise((resolve, reject) => {
    let urlPath = `/rest/v1/${table}`;
    if (query) urlPath += `?${query}`;

    const options = {
      hostname: "kjmcpvecywgjhvihrert.supabase.co",
      path: urlPath,
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" ? "return=representation" : undefined,
      },
    };
    Object.keys(options.headers).forEach(
      (k) => options.headers[k] === undefined && delete options.headers[k]
    );

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Supabase request timed out"));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function logActivity(activityType, description, metadata = {}) {
  const gitEmail = getGitEmail();
  try {
    await supabaseRequest("POST", "watcher_activity", {
      git_email: gitEmail,
      activity: description,
      activity_type: activityType,
      metadata,
    });
  } catch {
    // non-blocking — network failures don't break the pipeline
  }
}

async function getRecentActivity(limit = 20) {
  try {
    return await supabaseRequest(
      "GET",
      "watcher_activity",
      null,
      `order=created_at.desc&limit=${limit}&select=git_email,activity,activity_type,created_at`
    );
  } catch {
    return [];
  }
}

async function logChangelog(version, changeType, description) {
  const gitEmail = getGitEmail();
  try {
    await supabaseRequest("POST", "watcher_changelog", {
      version,
      change_type: changeType,
      description,
      git_email: gitEmail,
    });
  } catch {
    // non-blocking
  }
}

async function getChangelog(limit = 20) {
  try {
    return await supabaseRequest(
      "GET",
      "watcher_changelog",
      null,
      `order=created_at.desc&limit=${limit}`
    );
  } catch {
    return [];
  }
}

module.exports = {
  logActivity,
  getRecentActivity,
  logChangelog,
  getChangelog,
  getGitEmail,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
};
