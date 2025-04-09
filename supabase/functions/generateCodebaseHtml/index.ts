import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import hljs from "https://esm.sh/highlight.js@11.10.0/lib/core.js";
import javascript from "https://esm.sh/highlight.js@11.10.0/lib/languages/javascript.js";
import typescript from "https://esm.sh/highlight.js@11.10.0/lib/languages/typescript.js";
import python from "https://esm.sh/highlight.js@11.10.0/lib/languages/python.js";
import cpp from "https://esm.sh/highlight.js@11.10.0/lib/languages/cpp.js";
import java from "https://esm.sh/highlight.js@11.10.0/lib/languages/java.js";
import plaintext from "https://esm.sh/highlight.js@11.10.0/lib/languages/plaintext.js"; // Add plaintext
import { decodeBase64 } from "https://deno.land/std@0.223.0/encoding/base64.ts";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("java", java);
hljs.registerLanguage("plaintext", plaintext); // Register plaintext

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const githubToken = Deno.env.get("GITHUB_TOKEN");
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Function initialized with SUPABASE_URL:", supabaseUrl);

serve(async (req: Request) => {
  console.log("Received request:", req.method, req.url);

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    console.log("Handling CORS preflight request");
    return new Response(null, { headers });
  }

  try {
    if (req.method !== "POST") {
      console.log("Method not allowed:", req.method);
      return new Response("Method not allowed", { status: 405, headers });
    }

    const { repoUrl } = await req.json();
    console.log("Received repoUrl:", repoUrl);

    if (!repoUrl || typeof repoUrl !== "string") {
      console.log("Invalid repo URL:", repoUrl);
      return new Response("Invalid repo URL", { status: 400, headers });
    }

    // Delete any existing cache entries for this repo URL to prevent old URL format
    console.log("Deleting any existing cache entries for:", repoUrl);
    await supabase
      .from("repo_cache")
      .delete()
      .eq("repo_url", repoUrl);
    console.log("Cleared cached entries for this repo");

    const { data: cached } = await supabase
      .from("repo_cache")
      .select("storage_url")
      .eq("repo_url", repoUrl)
      .single();
    console.log("Cache check result:", cached);

    if (cached) {
      console.log("Returning cached result:", cached.storage_url);
      return new Response(JSON.stringify({ downloadUrl: cached.storage_url }), { headers });
    }

    let owner, repo;
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split("/").filter((p) => p);
      if (pathParts.length < 2) throw new Error("Invalid URL format");
      owner = pathParts[0];
      repo = pathParts[1];
    } catch (error) {
      console.error("Error parsing repo URL:", error);
      return new Response("Invalid GitHub repo URL", { status: 400, headers });
    }
    console.log("Parsed owner:", owner, "repo:", repo);

    const headersGitHub = githubToken ? { Authorization: `token ${githubToken}` } : {};

    const repoUrlApi = `https://api.github.com/repos/${owner}/${repo}`;
    console.log("Fetching repo metadata:", repoUrlApi);
    const repoResponse = await fetch(repoUrlApi, { headers: headersGitHub });
    if (!repoResponse.ok) {
      console.error("GitHub API error (repo fetch):", repoResponse.statusText);
      return new Response(`GitHub API error (repo fetch): ${repoResponse.statusText}`, { status: repoResponse.status, headers });
    }
    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch;
    console.log("Default branch:", defaultBranch);

    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
    console.log("Fetching tree:", treeUrl);
    const treeResponse = await fetch(treeUrl, { headers: headersGitHub });
    if (!treeResponse.ok) {
      console.error("GitHub API error (tree fetch):", treeResponse.statusText);
      return new Response(`GitHub API error (tree fetch): ${treeResponse.statusText}`, { status: treeResponse.status, headers });
    }
    const treeData = await treeResponse.json();
    console.log("Fetched tree data:", treeData.tree.length, "items");

    let htmlContent = `
      <html>
        <head>
          <title>${repo} Codebase</title>
          <style>
            pre { background: #f4f4f4; padding: 10px; border-radius: 5px; }
            h2 { margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>${repo} Codebase</h1>
    `;
    let fileCount = 0;
    const maxFiles = 50; // Limit to 50 files to avoid timeout
    for (const item of treeData.tree) {
      if (fileCount >= maxFiles) {
        console.log("Reached max file limit:", maxFiles);
        break;
      }
      if (item.type === "blob") {
        fileCount++;
        const contentUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`;
        console.log("Fetching content:", contentUrl);
        const contentResponse = await fetch(contentUrl, { headers: headersGitHub });
        if (contentResponse.ok) {
          const contentData = await contentResponse.json();
          const decodedContent = new TextDecoder().decode(decodeBase64(contentData.content));
          const ext = item.path.split(".").pop()?.toLowerCase();
          let lang = "";
          switch (ext) {
            case "py": lang = "python"; break;
            case "js": lang = "javascript"; break;
            case "ts": lang = "typescript"; break;
            case "cpp": lang = "cpp"; break;
            case "java": lang = "java"; break;
            default: lang = "plaintext";
          }
          console.log(`Highlighting ${item.path} as ${lang}`);
          const highlighted = hljs.highlight(decodedContent, { language: lang }).value;
          htmlContent += `
            <h2>${item.path}</h2>
            <pre><code class="${lang}">${highlighted}</code></pre>
          `;
        } else {
          console.warn(`Failed to fetch content for ${item.path}: ${contentResponse.statusText}`);
        }
      }
    }
    htmlContent += `</body></html>`;

    const storageKey = `${owner}-${repo}-${Date.now()}.html`;
    console.log("Uploading to storage:", storageKey);
    console.log("Using bucket name: public1");
    const { error: uploadError } = await supabase.storage
      .from("public1")
      .upload(storageKey, htmlContent, { contentType: "text/html" });
    if (uploadError) {
      console.error("Storage upload failed:", uploadError.message);
      return new Response(`Storage upload failed: ${uploadError.message}`, { status: 500, headers });
    }
    console.log("Uploaded to storage:", storageKey);

    // Hardcode the download URL with the correct bucket name
    const downloadUrl = `${supabaseUrl}/storage/v1/object/public/public1/${storageKey}`;
    console.log("Final downloadUrl with hardcoded public1 bucket:", downloadUrl);

    // Cache in database
    console.log("Inserting into repo_cache:", { repo_url: repoUrl, storage_url: downloadUrl });
    await supabase.from("repo_cache").insert({ repo_url: repoUrl, storage_url: downloadUrl });
    console.log("Cached result in database");

    return new Response(JSON.stringify({ downloadUrl }), { headers });
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(`Internal Server Error: ${error.message}`, { status: 500, headers });
  }
});