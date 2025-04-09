import { serve } from "bun";
import { createClient } from "@supabase/supabase-js";
import hljs from "highlight.js";

// Supabase setup (replace with your credentials)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Language mapping for syntax highlighting
const langMap = {
  js: "javascript",
  py: "python",
  ts: "typescript",
  cpp: "cpp",
  java: "java",
  md: "markdown",
};

serve({
  port: 3000,
  async fetch(req) {
    if (req.method !== "POST" || !req.url.endsWith("/generate")) {
      return new Response("Not Found", { status: 404 });
    }

    const { repoUrl } = await req.json();

    // Check cache
    const { data: cached } = await supabase
      .from("repo_cache")
      .select("storage_url")
      .eq("repo_url", repoUrl)
      .single();

    if (cached) {
      return new Response(JSON.stringify({ downloadUrl: cached.storage_url }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse GitHub URL
    let owner, repo;
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split("/").filter((p) => p);
      if (pathParts.length < 2) throw new Error("Invalid URL");
      owner = pathParts[0];
      repo = pathParts[1];
    } catch {
      return new Response("Invalid GitHub repo URL", { status: 400 });
    }

    // Fetch repository tree
    const treeResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`
    );
    if (!treeResponse.ok) {
      return new Response(`GitHub API error: ${treeResponse.statusText}`, {
        status: treeResponse.status,
      });
    }
    const treeData = await treeResponse.json();

    // Generate HTML
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
    for (const item of treeData.tree) {
      if (item.type === "blob") {
        const contentResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`
        );
        if (contentResponse.ok) {
          const contentData = await contentResponse.json();
          const decodedContent = Buffer.from(contentData.content, "base64").toString("utf-8");
          const ext = item.path.split(".").pop()?.toLowerCase();
          const lang = langMap[ext] || "plaintext";
          const highlighted = hljs.highlight(decodedContent, { language: lang }).value;
          htmlContent += `
            <h2>${item.path}</h2>
            <pre><code class="${lang}">${highlighted}</code></pre>
          `;
        }
      }
    }
    htmlContent += `</body></html>`;

    // Upload to Supabase Storage
    const storageKey = `${owner}-${repo}-${Date.now()}.html`;
    const { error, data } = await supabase.storage
      .from("public1")
      .upload(storageKey, htmlContent, { contentType: "text/html", upsert: true });
    if (error) {
      console.error("Storage upload failed:", error);
      return new Response(JSON.stringify({ error: "Storage upload failed", details: error }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get public URL properly
    const { data: storageData } = await supabase.storage.from("public1").getPublicUrl(storageKey);
    if (!storageData || !storageData.publicUrl) {
      console.error("Failed to get public URL");
      return new Response(JSON.stringify({ error: "Failed to get public URL" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
    const downloadUrl = storageData.publicUrl;
    console.log("Generated public URL:", downloadUrl);

    // Cache in database
    await supabase.from("repo_cache").insert({ repo_url: repoUrl, storage_url: downloadUrl });

    return new Response(JSON.stringify({ downloadUrl }), {
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log("Server running on http://localhost:3000");