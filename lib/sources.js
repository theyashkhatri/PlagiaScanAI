// ═══════════════════════════════════════════════════════════
// PLAGISCAN AI — Free Source APIs (No Keys Required)
// Wikipedia (title + full-text), DuckDuckGo, Crossref,
// Semantic Scholar, Open Library, Web Scraping
// ═══════════════════════════════════════════════════════════

const cheerio = require('cheerio');
const UA = 'PlagiScanAI/2.0 (Academic Project; Plagiarism Detection)';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Wikipedia ─────────────────────────────────────────────

async function searchWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=8&srprop=snippet`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await delay(800 * attempt); // backoff on retry
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (res.status === 429) { await delay(1500); continue; } // explicit rate limit
      if (!res.ok) return [];
      const data = await res.json();
      const results = data.query?.search || [];
      if (results.length === 0 && attempt < 2) { await delay(600); continue; } // empty = possibly throttled
      return results.map(r => ({
        title: r.title,
        snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
        source_type: 'wikipedia',
      }));
    } catch (e) { if (attempt === 2) return []; }
  }
  return [];
}

// Full-text search inside Wikipedia article bodies — single API call returning
// up to 8 results, deduped against title-search results in searchAllSources.
async function searchWikipediaFullText(query) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srwhat=text&format=json&utf8=1&srlimit=8&srprop=snippet`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.query?.search || []).map(r => ({
      title: r.title,
      snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      source_type: 'wikipedia',
    }));
  } catch (e) { return []; }
}

async function getWikipediaContent(title) {
  try {
    // No exchars cap — fetch full article text, truncate server-side to 15k chars.
    // exintro=0 + explaintext=1 returns the full plain-text article body.
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&explaintext=1&exsectionformat=plain&format=json`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return '';
    const data = await res.json();
    const pages = data.query?.pages || {};
    const extract = Object.values(pages)[0]?.extract || '';
    return extract.substring(0, 15000);
  } catch (e) { return ''; }
}

// ─── Crossref (Academic Papers) ────────────────────────────

async function searchCrossref(query) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=3&select=title,abstract,URL,DOI`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.message?.items || []).filter(i => i.abstract || i.title).map(i => ({
      title: (i.title || [''])[0],
      snippet: (i.abstract || '').replace(/<[^>]+>/g, '').substring(0, 600),
      url: i.URL || `https://doi.org/${i.DOI}`,
      source_type: 'academic',
    }));
  } catch (e) { return []; }
}

// ─── Semantic Scholar (Free, No Key for basic use) ─────────

async function searchSemanticScholar(query) {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=3&fields=title,abstract,url`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).filter(p => p.abstract).map(p => ({
      title: p.title || '',
      snippet: (p.abstract || '').substring(0, 600),
      url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
      source_type: 'academic',
    }));
  } catch (e) { return []; }
}

// ─── DuckDuckGo Instant Answer API ─────────────────────────

async function searchDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    const results = [];
    if (data.Abstract && data.Abstract.length > 30) {
      results.push({
        title: data.Heading || query,
        snippet: data.Abstract.substring(0, 600),
        url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        source_type: 'web',
      });
    }
    // Related topics often contain useful content
    (data.RelatedTopics || []).slice(0, 3).forEach(t => {
      if (t.Text && t.Text.length > 30) {
        results.push({
          title: t.Text.split(' - ')[0] || query,
          snippet: t.Text.substring(0, 400),
          url: t.FirstURL || '',
          source_type: 'web',
        });
      }
    });
    return results;
  } catch (e) { return []; }
}

// ─── Web Page Scraping (using cheerio) ─────────────────────

async function scrapeWebPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return '';
    const html = await res.text();
    const $ = cheerio.load(html);
    // Remove unwanted elements
    $('script, style, nav, header, footer, aside, form, iframe, noscript, .sidebar, .menu, .nav, .footer, .header, .advertisement, .ad').remove();
    // Extract main content
    const selectors = ['article', 'main', '.content', '.post-content', '.article-body', '#content', '.entry-content'];
    let text = '';
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 100) {
        text = el.text();
        break;
      }
    }
    if (!text) text = $('body').text();
    // Clean up
    return text.replace(/\s+/g, ' ').trim().substring(0, 5000);
  } catch (e) { return ''; }
}

// ─── Open Library (Book search) ────────────────────────────

async function searchOpenLibrary(query) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=2&fields=title,first_sentence,author_name,key`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.docs || []).filter(d => d.first_sentence).map(d => ({
      title: `${d.title} — ${(d.author_name || ['Unknown'])[0]}`,
      snippet: (Array.isArray(d.first_sentence) ? d.first_sentence.join(' ') : d.first_sentence || '').substring(0, 400),
      url: `https://openlibrary.org${d.key}`,
      source_type: 'book',
    }));
  } catch (e) { return []; }
}

// ─── Source Availability Cache ─────────────────────────────
// Track which external sources are responding to avoid wasting
// timeout budget on dead endpoints each request
const sourceHealth = {
  crossref: { ok: true, failCount: 0, lastCheck: 0 },
  scholar: { ok: true, failCount: 0, lastCheck: 0 },
  duckduckgo: { ok: true, failCount: 0, lastCheck: 0 },
  openlibrary: { ok: true, failCount: 0, lastCheck: 0 },
};

function markSourceFailed(name) {
  const h = sourceHealth[name];
  if (!h) return;
  h.failCount++;
  h.lastCheck = Date.now();
  // Only mark dead after 3 consecutive actual errors (not empty result sets —
  // empty results are normal for specific queries and shouldn't disable a source)
  if (h.failCount >= 3) h.ok = false;
}
function markSourceOk(name) {
  const h = sourceHealth[name];
  if (!h) return;
  h.failCount = 0;
  h.ok = true;
  h.lastCheck = Date.now();
}
// Re-probe a dead source after 5 minutes
function sourceIsAvailable(name) {
  const h = sourceHealth[name];
  if (!h) return true;
  if (h.ok) return true;
  return Date.now() - h.lastCheck > 5 * 60 * 1000;
}

async function trySource(name, fn) {
  if (!sourceIsAvailable(name)) return [];
  try {
    const result = await fn();
    // Only count as failure if the call itself threw or timed out, not empty results
    if (result && result.length > 0) markSourceOk(name);
    return result || [];
  } catch {
    markSourceFailed(name);
    return [];
  }
}

// ─── Batch Search All Sources ──────────────────────────────

async function searchAllSources(query, options = {}) {
  // Single Wikipedia title search per query — two concurrent wiki calls per
  // sentence hit Wikipedia's rate limit. Full-text search is used in Phase 2.
  const promises = [searchWikipedia(query)];
  if (options.academic !== false) {
    promises.push(trySource('crossref', () => searchCrossref(query)));
    promises.push(trySource('scholar', () => searchSemanticScholar(query)));
  }
  if (options.internet !== false) {
    // DDG instant-answer API only returns results for 1-2 word topic names.
    // Extract the two most prominent content words from the query to use as topic.
    const ddgWords = query.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    const ddgQuery = ddgWords.slice(0, 2).join(' ');
    if (ddgQuery) promises.push(trySource('duckduckgo', () => searchDuckDuckGo(ddgQuery)));
    promises.push(trySource('openlibrary', () => searchOpenLibrary(query)));
  }

  const results = await Promise.allSettled(promises);
  const allResults = [];
  const seenKeys = new Set();
  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      r.value.forEach(item => {
        // Deduplicate by source_type+title so the same Wikipedia article isn't
        // scored twice, but a DDG result with the same title as a Wikipedia
        // article is kept (different content, different URL)
        const key = `${item.source_type}::${item.title?.toLowerCase().trim()}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          allResults.push(item);
        }
      });
    }
  });
  return allResults;
}

module.exports = {
  searchWikipedia, searchWikipediaFullText, getWikipediaContent,
  searchCrossref, searchSemanticScholar,
  searchDuckDuckGo, searchOpenLibrary,
  scrapeWebPage, searchAllSources,
  delay,
};
