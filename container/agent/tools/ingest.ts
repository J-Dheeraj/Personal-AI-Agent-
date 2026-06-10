import { Mnemon } from '../mnemon';

const MAX_STORE_CHARS = 50000;

export async function ingestTool(url: string, mnemon: Mnemon): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();

    let text: string;
    let title: string = new URL(url).hostname;

    // Attempt Readability extraction; fall back to regex strip
    try {
      const { JSDOM } = await import('jsdom');
      const { Readability } = await import('@mozilla/readability');
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      if (article) {
        text = article.textContent.replace(/\s+/g, ' ').trim();
        title = article.title || title;
      } else {
        text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } catch {
      text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    const domain = new URL(url).hostname;
    const stored = text.slice(0, MAX_STORE_CHARS);

    await mnemon.addFact(url, 'title', title, domain);
    await mnemon.addFact(url, 'content', stored, domain);
    await mnemon.addFact(url, 'summary', text.slice(0, 500), domain);
    await mnemon.addFact(url, 'source', domain, 'system');
    await mnemon.addFact(url, 'ingested_at', new Date().toISOString(), 'system');

    console.log(`[ingest] Stored ${stored.length} chars from ${url}`);
    return `Ingested ${url} — stored ${stored.length.toLocaleString()} characters (title: "${title}").`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to ingest ${url}: ${msg}`;
  }
}
