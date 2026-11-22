
import { markdownToHtml } from "./markdownHelper.cjs";
import { wikiToHtml } from "./wikitextHelper.js";
import { renderMDX, generateHydrationScript } from "./mdxRenderer.js";
import { parseWithWorker, terminateParserPool } from "./parserPool.js";

const DEFAULT_WIKITEXT_ARGS = { db: "noDB" };

function formatBlockBody(raw) {
  return raw
    .trim()
    .replace(/\r?\n+/g, "<br />");
}

function transformInsideBlockquote(quoteInner) {
  let out = quoteInner;

  out = out.replace(/\[Warning\]([\s\S]*?)\[\/Warning\]/gi, (_, body) =>
    `\n\n<div class="ursa-bq-tag ursa-bq-tag--warning"><span class="ursa-bq-tag__badge">!</span><div class="ursa-bq-tag__body">${formatBlockBody(body)}</div></div>\n\n`
  );

  out = out.replace(/\[Info\]([\s\S]*?)\[\/Info\]/gi, (_, body) =>
    `\n\n<div class="ursa-bq-tag ursa-bq-tag--info"><span class="ursa-bq-tag__badge">i</span><div class="ursa-bq-tag__body">${formatBlockBody(body)}</div></div>\n\n`
  );

  out = out.replace(/\[titt?le\]([\s\S]*?)\[\/titt?le\]/gi, (_, body) =>
    `\n\n<div class="ursa-bq-title">${formatBlockBody(body)}</div>\n\n`
  );

  out = out.replace(/^[ \t]*\[titt?le\][ \t]*(.+)$/gim, (_, body) =>
    `\n\n<div class="ursa-bq-title">${body.trim()}</div>\n\n`
  );

  return out;
}

function applyUrsaCustomTags(text) {
  if (typeof text !== "string" || !text) return text;

  const codeBlocks = [];
  let protectedText = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (m) => {
    const idx = codeBlocks.length;
    codeBlocks.push(m);
    return `@@URSA_CODE_${idx}@@`;
  });

  protectedText = protectedText.replace(/(?:^[ \t]*>.*(?:\r?\n|$))+/gm, (block) => {
    const lines = block.split(/\r?\n/);
    const strippedLines = lines.map((line) => line.replace(/^[ \t]*>[ \t]?/, ""));
    const transformedInner = transformInsideBlockquote(strippedLines.join("\n"));
    return transformedInner
      .split("\n")
      .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
      .join("\n");
  });

  return protectedText.replace(/@@URSA_CODE_(\d+)@@/g, (_, idx) => codeBlocks[Number(idx)]);
}


/**
 * Render a file synchronously (legacy/fallback)
 * Note: .mdx files require async rendering; use renderFileAsync instead.
 * @param {Object} options - Render options
 * @param {string} options.fileContents - Raw file content
 * @param {string} options.type - File extension (.md, .txt)
 * @param {string} options.dirname - Directory name
 * @param {string} options.basename - Base filename
 * @returns {string} Rendered HTML
 */
export function renderFile({ fileContents, type, dirname, basename }) {
  switch (type) {
    case ".md":
      return markdownToHtml(applyUrsaCustomTags(fileContents));
    case ".txt":
      return wikiToHtml({
        wikitext: applyUrsaCustomTags(fileContents),
        articleName: basename,
        args: { ...DEFAULT_WIKITEXT_ARGS, db: dirname },
      })?.html;
  }
}

/**
 * Render a file asynchronously using worker threads for parallel processing
 * Falls back to main thread for wikitext or if workers are unavailable
 * @param {Object} options - Render options
 * @param {string} options.fileContents - Raw file content
 * @param {string} options.type - File extension (.md, .txt, or .mdx)
 * @param {string} options.dirname - Directory name
 * @param {string} options.basename - Base filename
 * @param {string} [options.filePath] - Absolute path to file (required for .mdx)
 * @param {string} [options.sourceRoot] - Source root directory (for .mdx absolute imports)
 * @param {boolean} [options.useWorker=true] - Whether to attempt worker thread parsing
 * @param {boolean} [options.hydrate=false] - Whether to enable client-side hydration (.mdx only)
 * @returns {Promise<string|{html: string, hydrationScript?: string}>} Rendered HTML or object with HTML and hydration script
 */
export async function renderFileAsync({ fileContents, type, dirname, basename, filePath, sourceRoot, useWorker = true, hydrate = false }) {
  // Wikitext always runs on main thread due to complex ES module dependencies
  if (type === ".txt") {
    return wikiToHtml({
      wikitext: applyUrsaCustomTags(fileContents),
      articleName: basename,
      args: { ...DEFAULT_WIKITEXT_ARGS, db: dirname },
    })?.html;
  }
  
  // Markdown can use worker threads
  if (type === ".md") {
    if (useWorker) {
      return parseWithWorker(
        applyUrsaCustomTags(fileContents),
        type,
        dirname,
        basename,
        () => markdownToHtml(applyUrsaCustomTags(fileContents)) // Fallback to main thread
      );
    }
    return markdownToHtml(applyUrsaCustomTags(fileContents));
  }

  // MDX uses mdx-bundler + React SSR (always async, no worker support)
  // Falls back to markdown rendering if MDX compilation fails.
  // Always returns the object form: { html, hydrationScript, inputs, failed }.
  // `inputs` lists the module files the bundle loaded; `failed` is set when the
  // fallback rendered, so callers know the dependency list is incomplete.
  if (type === ".mdx") {
    try {
      const result = await renderMDX({ source: applyUrsaCustomTags(fileContents), filePath, sourceRoot, hydrate });
      
      // If hydration was requested and we have client code, include the hydration script
      return {
        html: result.html,
        hydrationScript: hydrate && result.clientCode ? generateHydrationScript(result.clientCode) : '',
        inputs: result.inputs ?? [],
        failed: false,
      };
    } catch (mdxError) {
      // Extract a concise error description for the warning banner
      const errorMsg = mdxError.message || String(mdxError);
      const shortPath = filePath?.split('/').slice(-3).join('/') || 'unknown file';
      
      // Extract the actionable part of the error (skip the "MDX compilation failed for <path>:" preamble)
      const lines = errorMsg.split('\n').filter(l => l.trim());
      const actionableLine = lines.length > 1 ? lines.slice(1).join(' ').trim() : lines[0];
      const errorDetail = actionableLine.slice(0, 300);

      console.warn(`!  MDX compilation failed for ${shortPath}, falling back to Markdown rendering`);
      console.warn(`   ${errorDetail}`);

      // Render as markdown instead (handles raw HTML fine, just no custom components)
      const markdownHtml = markdownToHtml(applyUrsaCustomTags(fileContents));
      const warningBanner = `<div style="background:#fef3cd;border:1px solid #ffc107;color:#856404;padding:0.75rem 1rem;margin-bottom:1rem;border-radius:4px;font-size:0.875rem;">`
        + `<strong>! MDX compilation error</strong> — this page was rendered as Markdown (custom components like &lt;CharacterCard&gt; will not appear).<br>`
        + `<code style="font-size:0.8rem;word-break:break-all;">${errorDetail.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`
        + `</div>`;
      return {
        html: warningBanner + markdownHtml,
        hydrationScript: '',
        inputs: mdxError.inputs ?? [],
        componentDirs: mdxError.componentDirs ?? [],
        failed: true,
        error: errorDetail,
      };
    }
  }
  
  return undefined;
}

// Re-export for cleanup on shutdown
export { terminateParserPool };