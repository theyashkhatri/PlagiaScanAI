// ═══════════════════════════════════════════════════════════
// PLAGISCAN AI — Free Source APIs (No Keys Required)
// Wikipedia, Crossref, Semantic Scholar, DuckDuckGo, Scraping
// ═══════════════════════════════════════════════════════════

const cheerio = require('cheerio');
const UA = 'PlagiScanAI/2.0 (Academic Project; Plagiarism Detection)';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Wikipedia ─────────────────────────────────────────────

async function searchWikipedia(query) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=5&srprop=snippet`;
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
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=0&explaintext=1&format=json&exchars=5000`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return '';
    const data = await res.json();
    const pages = data.query?.pages || {};
    return Object.values(pages)[0]?.extract || '';
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

// ─── Batch Search All Sources ──────────────────────────────

async function searchAllSources(query, options = {}) {
  const promises = [searchWikipedia(query)];
  if (options.academic !== false) {
    promises.push(searchCrossref(query));
    promises.push(searchSemanticScholar(query));
  }
  if (options.internet !== false) {
    promises.push(searchDuckDuckGo(query));
    promises.push(searchOpenLibrary(query));
  }

  const results = await Promise.allSettled(promises);
  const allResults = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      allResults.push(...r.value);
    }
  });
  return allResults;
}

module.exports = {
  searchWikipedia, getWikipediaContent,
  searchCrossref, searchSemanticScholar,
  searchDuckDuckGo, searchOpenLibrary,
  scrapeWebPage, searchAllSources,
  delay,
};
