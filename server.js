const express = require('express');
const cors = require('cors');
const path = require('path');
const algo = require('./lib/algorithms');
const { detectAIWritten } = require('./lib/ai-detector');
const sources = require('./lib/sources');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Log Streaming (SSE) ───────────────────────────────────
let logClients = new Map();

app.get('/api/logs', (req, res) => {
  const requestId = req.query.id;
  if (!requestId) return res.status(400).send('Missing requestId');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  logClients.set(requestId, res);
  req.on('close', () => logClients.delete(requestId));
});

function streamLog(requestId, message, type = 'info') {
  const client = logClients.get(requestId);
  if (client) {
    client.write(`data: ${JSON.stringify({ message, type })}\n\n`);
  }
}

// ═══════════════════════════════════════════════════════════
// PLAGISCAN AI v2 — FULL LOCAL PLAGIARISM ENGINE
// No external API keys required
// Wikipedia + Crossref + Semantic Scholar + DuckDuckGo
// + Open Library + Web Scraping + AI Detection
// ═══════════════════════════════════════════════════════════

// ─── Text Utilities ────────────────────────────────────────

function extractSentences(text) {
  return text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/)
    .map(s => s.trim()).filter(s => s.length > 20 && s.split(/\s+/).length >= 4);
}

function selectKeySentences(sentences) {
  // Include all sentences ≥8 words, proportional to text length, capped at 25.
  // Purely length-sorted selection was skipping short but heavily-plagiarised sentences.
  const eligible = sentences.filter(s => s.split(/\s+/).length >= 8);
  const max = Math.min(eligible.length, Math.max(15, Math.ceil(sentences.length * 0.6)), 25);
  return eligible
    .map(s => ({ text: s, wordCount: s.split(/\s+/).length }))
    .sort((a, b) => b.wordCount - a.wordCount)
    .slice(0, max)
    .map(s => s.text);
}

function extractKeywords(text, count = 6) {
  const words = algo.tokenizeFiltered(text);
  const freq = {};
  words.forEach(w => { if (w.length > 3) freq[w] = (freq[w] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, count).map(([w]) => w);
}

function splitIntoChunks(text) {
  const sents = text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/)
    .map(s => s.trim()).filter(s => s.length > 15);
  const chunks = [...sents];
  for (let i = 0; i < sents.length - 1; i++) chunks.push(sents[i] + ' ' + sents[i + 1]);
  for (let i = 0; i < sents.length - 2; i++) chunks.push(sents[i] + ' ' + sents[i + 1] + ' ' + sents[i + 2]);
  // Drop chunks too short for fingerprinting metrics to produce meaningful scores
  return chunks.filter(c => algo.tokenize(c).length >= 20);
}

function computeSimilarity(inputSentence, sourceText) {
  if (sourceText.length < 300) return algo.compositeScore(inputSentence, sourceText);
  const chunks = splitIntoChunks(sourceText);
  let best = 0;
  for (const chunk of chunks) {
    const score = algo.compositeScore(inputSentence, chunk);
    if (score > best) best = score;
    if (best > 0.65) break;
  }
  return best;
}

// ─── Main Analysis Endpoint ────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, sensitivity = 'standard', options = {}, requestId } = req.body;
    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: { message: 'Text too short. Need at least 50 characters.' } });
    }

    const inputText = text.trim();
    const allSentences = extractSentences(inputText);
    const keySentences = selectKeySentences(allSentences);
    const totalWords = algo.tokenize(inputText).length;
    const keywords = extractKeywords(inputText, 6);

    streamLog(requestId, `\n${'═'.repeat(60)}`);
    streamLog(requestId, `📝 PlagiScan AI v2 — Analyzing ${totalWords} words, ${allSentences.length} sentences`);
    streamLog(requestId, `🔑 Keywords: ${keywords.join(', ')}`);
    streamLog(requestId, `🔍 Checking ${keySentences.length} key sentences`);
    streamLog(requestId, `⚙️  Sensitivity: ${sensitivity} | Sources: Wiki+Crossref+Scholar+DDG+OpenLib`);
    streamLog(requestId, `${'═'.repeat(60)}\n`);

    const segments = [];
    const sourceMap = {};
    let totalFlaggedWords = 0;
    const contentCache = new Map();

    // ── Phase 1: Search all sources for each key sentence ──
    streamLog(requestId, '📡 Phase 1: Multi-source sentence search...');
    for (let i = 0; i < keySentences.length; i++) {
      const sentence = keySentences[i];
      // Build query from top content words + a mid-phrase fragment for specificity
      const contentWords = algo.tokenizeFiltered(sentence).slice(0, 5);
      const words = sentence.split(/\s+/);
      const midPhrase = words.slice(Math.floor(words.length / 3), Math.floor(words.length / 3) + 5);
      const searchQuery = [...new Set([...contentWords, ...midPhrase])].join(' ');
      streamLog(requestId, `  [${i + 1}/${keySentences.length}] "${searchQuery.substring(0, 50)}..."`);

      // Search all sources in parallel
      const allResults = await sources.searchAllSources(searchQuery, options);
      const sourceTypes = {};
      allResults.forEach(r => { sourceTypes[r.source_type] = (sourceTypes[r.source_type] || 0) + 1; });
      streamLog(requestId, `    📚 Found: ${Object.entries(sourceTypes).map(([k, v]) => `${k}:${v}`).join(' ')}`, 'dim');

      let bestMatch = null;
      let bestScore = 0;

      for (const result of allResults) {
        let content = result.snippet;

        // Fetch full Wikipedia article — cache by title, score all returned articles
        if (result.source_type === 'wikipedia') {
          if (!contentCache.has(result.title)) {
            const full = await sources.getWikipediaContent(result.title);
            if (full) contentCache.set(result.title, full);
          }
          if (contentCache.has(result.title)) content = contentCache.get(result.title);
        }

        // Try scraping web pages for deeper content
        if (result.source_type === 'web' && result.url) {
          if (!contentCache.has(result.url)) {
            const scraped = await sources.scrapeWebPage(result.url);
            if (scraped && scraped.length > 100) contentCache.set(result.url, scraped);
          }
          if (contentCache.has(result.url)) content = contentCache.get(result.url);
        }

        if (!content || content.length < 20) continue;

        const score = computeSimilarity(sentence, content);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { ...result, score };
        }
      }

      // Sensitivity thresholds
      const threshold = sensitivity === 'strict' ? 0.06 : sensitivity === 'lenient' ? 0.22 : 0.10;

      if (bestMatch && bestScore >= threshold) {
        const sentenceWords = sentence.split(/\s+/).length;
        let type, reason;

        if (bestScore >= 0.35) {
          type = 'high';
          reason = `High similarity (${(bestScore * 100).toFixed(0)}%) — matches: ${bestMatch.title}`;
          totalFlaggedWords += sentenceWords;
        } else if (bestScore >= 0.20) {
          type = 'medium';
          reason = `Moderate similarity (${(bestScore * 100).toFixed(0)}%) — overlaps: ${bestMatch.title}`;
          totalFlaggedWords += Math.round(sentenceWords * 0.7);
        } else {
          type = 'paraphrase';
          reason = `Possible paraphrase (${(bestScore * 100).toFixed(0)}%) from: ${bestMatch.title}`;
          totalFlaggedWords += Math.round(sentenceWords * 0.4);
        }

        const displayText = sentence.length > 150 ? sentence.substring(0, 147) + '...' : sentence;
        streamLog(requestId, `    ✓ MATCH [${type}] ${(bestScore * 100).toFixed(0)}% → ${bestMatch.title.substring(0, 45)}`);

        segments.push({
          text: displayText, type, reason,
          source: bestMatch.title, source_url: bestMatch.url, similarity: bestScore,
        });

        const srcKey = bestMatch.title;
        if (!sourceMap[srcKey]) sourceMap[srcKey] = { title: bestMatch.title, url: bestMatch.url, matchedWords: 0, matchCount: 0, bestScore: 0 };
        sourceMap[srcKey].matchedWords += sentenceWords;
        sourceMap[srcKey].matchCount++;
        if (bestScore > sourceMap[srcKey].bestScore) sourceMap[srcKey].bestScore = bestScore;
      } else {
        streamLog(requestId, `    ○ No significant match`, 'dim');
      }

      if (i < keySentences.length - 1) await sources.delay(1300);
    }

    // ── Phase 2: Keyword deep scan ──
    // Search Wikipedia by keyword to get the canonical article title, then use
    // already-cached content where possible to avoid redundant fetches.
    streamLog(requestId, `\n📖 Phase 2: Deep keyword scan (${keywords.length} keywords)...`);
    const phase2Checked = new Set(); // track article titles already scanned in Phase 2
    for (const keyword of keywords.slice(0, 4)) {
      // Full-text search finds articles where the keyword appears in the body,
      // not just the title — better coverage for Phase 2's deep scan
      const wikiHits = await sources.searchWikipediaFullText(keyword);
      const articleTitle = wikiHits.length > 0 ? wikiHits[0].title : keyword;

      if (phase2Checked.has(articleTitle)) { streamLog(requestId, `  [skip] "${articleTitle}" already scanned`, 'dim'); continue; }
      phase2Checked.add(articleTitle);
      streamLog(requestId, `  [scan] "${articleTitle}" (keyword: ${keyword})`, 'dim');

      // Reuse Phase 1 cache if already fetched, otherwise fetch now
      let content = contentCache.get(articleTitle) || '';
      if (!content) {
        const full = await sources.getWikipediaContent(articleTitle);
        content = full ? full.substring(0, 5000) : '';
        if (content) contentCache.set(articleTitle, content);
      } else {
        // Use first 5k chars for Phase 2 scan to keep loop fast
        content = content.substring(0, 5000);
      }

      if (content && content.length > 100) {
        for (const sentence of allSentences) {
          // Use TF-IDF cosine overlap instead of substring prefix — catches semantic
          // duplicates regardless of word order or sentence start differences
          const alreadyFlagged = segments.some(s => algo.tfidfCosineSimilarity(s.text, sentence) > 0.75);
          if (alreadyFlagged) continue;

          const score = computeSimilarity(sentence, content);
          const threshold = sensitivity === 'strict' ? 0.08 : sensitivity === 'lenient' ? 0.22 : 0.12;

          if (score >= threshold) {
            const sentenceWords = sentence.split(/\s+/).length;
            const type = score >= 0.35 ? 'high' : score >= 0.20 ? 'medium' : 'paraphrase';
            totalFlaggedWords += type === 'high' ? sentenceWords : type === 'medium' ? Math.round(sentenceWords * 0.7) : Math.round(sentenceWords * 0.4);
            const displayText = sentence.length > 150 ? sentence.substring(0, 147) + '...' : sentence;
            const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(articleTitle.replace(/ /g, '_'))}`;
            streamLog(requestId, `    ✓ Deep [${type}] ${(score * 100).toFixed(0)}% → "${articleTitle}"`);
            segments.push({
              text: displayText, type,
              reason: `${type === 'high' ? 'High' : type === 'medium' ? 'Moderate' : 'Possible'} similarity (${(score * 100).toFixed(0)}%) with Wikipedia: ${articleTitle}`,
              source: `Wikipedia: ${articleTitle}`,
              source_url: wikiUrl, similarity: score,
            });
            if (!sourceMap[articleTitle]) sourceMap[articleTitle] = { title: `Wikipedia: ${articleTitle}`, url: wikiUrl, matchedWords: 0, matchCount: 0, bestScore: 0 };
            sourceMap[articleTitle].matchedWords += sentenceWords;
            sourceMap[articleTitle].matchCount++;
            if (score > sourceMap[articleTitle].bestScore) sourceMap[articleTitle].bestScore = score;
          }
        }
      }
      await sources.delay(300);
    }

    // ── Phase 3: AI-Written Detection ──
    streamLog(requestId, `\n🤖 Phase 3: AI-written content detection...`);
    const aiDetection = detectAIWritten(inputText);
    streamLog(requestId, `    AI Score: ${aiDetection.score}% — ${aiDetection.verdict}`, aiDetection.score > 60 ? 'warn' : 'info');
    for (const [key, metric] of Object.entries(aiDetection.metrics)) {
      streamLog(requestId, `      ${key}: ${metric.detail}`, 'dim');
    }

    // ── Calculate final scores ──
    const similarityScore = Math.min(100, Math.round((totalFlaggedWords / (totalWords || 1)) * 100));
    const originalScore = 100 - similarityScore;

    // ── Verdict ──
    let verdict, verdictLevel, verdictDesc;
    if (similarityScore > 50) {
      verdict = 'Highly Plagiarized'; verdictLevel = 'high';
      verdictDesc = `Significant matches found: ${similarityScore}% of content matches existing sources. ${segments.length} passage(s) flagged from ${Object.keys(sourceMap).length} source(s). Major revision with citations is strongly recommended.`;
    } else if (similarityScore > 25) {
      verdict = 'Moderate Plagiarism'; verdictLevel = 'medium';
      verdictDesc = `Moderate similarity (${similarityScore}%) detected. ${segments.length} passage(s) flagged. Review highlighted sections and add proper citations.`;
    } else if (similarityScore > 10) {
      verdict = 'Minor Plagiarism'; verdictLevel = 'low';
      verdictDesc = `Minor similarity (${similarityScore}%) detected. ${segments.length} passage(s) resemble existing content. Typical for academic writing.`;
    } else {
      verdict = 'Mostly Original'; verdictLevel = 'low';
      verdictDesc = `The text appears highly original (${originalScore}% unique). ${segments.length === 0 ? 'No' : 'Minimal'} matches with published sources.`;
    }

    // ── Sources ──
    const srcList = Object.values(sourceMap)
      .map(s => ({ title: s.title, url: s.url, match_percent: Math.min(100, Math.round((s.matchedWords / (totalWords || 1)) * 100)), match_level: s.bestScore >= 0.45 ? 'high' : s.bestScore >= 0.25 ? 'medium' : 'low' }))
      .sort((a, b) => b.match_percent - a.match_percent).slice(0, 10);

    // ── Suggestions ──
    const suggestions = [];
    const highSegs = segments.filter(s => s.type === 'high');
    const medSegs = segments.filter(s => s.type === 'medium');
    const paraSegs = segments.filter(s => s.type === 'paraphrase');

    if (highSegs.length > 0) suggestions.push({ type: 'high', text: `${highSegs.length} passage(s) closely match published sources. These must be quoted with citations or rewritten entirely.` });
    if (medSegs.length > 0) suggestions.push({ type: 'medium', text: `${medSegs.length} passage(s) show moderate overlap. Add citations for borrowed ideas and phrases.` });
    if (paraSegs.length > 0) suggestions.push({ type: 'info', text: `${paraSegs.length} passage(s) may be paraphrased. Even paraphrased content requires citing the original source.` });
    if (aiDetection.score >= 60) suggestions.push({ type: 'high', text: `AI Detection: ${aiDetection.verdict} (${aiDetection.score}% confidence). The text exhibits patterns typical of AI-generated content including ${aiDetection.metrics.transitionDensity.score > 50 ? 'high transition word density' : ''}${aiDetection.metrics.sentenceLengthVariance.score > 50 ? ', uniform sentence structure' : ''}${aiDetection.metrics.vocabularyRichness.score > 50 ? ', limited vocabulary diversity' : ''}.` });
    else if (aiDetection.score >= 35) suggestions.push({ type: 'medium', text: `AI Detection: ${aiDetection.verdict} (${aiDetection.score}% confidence). Some patterns suggest possible AI assistance. Review for authenticity.` });
    else suggestions.push({ type: 'good', text: `AI Detection: ${aiDetection.verdict} (${aiDetection.score}% confidence). Writing patterns appear natural and human-authored.` });
    if (similarityScore < 15 && aiDetection.score < 35) suggestions.push({ type: 'good', text: 'Good originality. The text appears to be original, human-written content.' });

    // ── Full Report ──
    const fullReport = `PLAGISCAN AI v2 — COMPREHENSIVE PLAGIARISM & AI DETECTION REPORT
Generated: ${new Date().toLocaleString()}
${'═'.repeat(60)}

DOCUMENT OVERVIEW:
Analyzed ${totalWords} words across ${allSentences.length} sentences.
${keySentences.length} key sentences were searched against ${contentCache.size} sources.

METHODOLOGY:
Multi-source comparison using advanced algorithms:
• TF-IDF + Cosine Similarity (semantic matching)
• Jaccard Coefficient + N-gram Fingerprinting (2/3/4-gram)
• Longest Common Subsequence (verbatim detection)
• Winnowing Fingerprinting (document-level matching)
Sources: Wikipedia, Crossref, Semantic Scholar, DuckDuckGo, Open Library
Sensitivity: ${sensitivity} mode

PLAGIARISM RESULTS:
Similarity: ${similarityScore}% | Originality: ${originalScore}%
Verdict: ${verdict}
Flagged: ${segments.length} passages | Sources: ${srcList.length}

${verdictDesc}

AI-WRITTEN CONTENT ANALYSIS:
AI Score: ${aiDetection.score}% — ${aiDetection.verdict}
${Object.entries(aiDetection.metrics).map(([k, m]) => `  • ${k}: ${m.detail}`).join('\n')}

${segments.length > 0 ? `FLAGGED PASSAGES:\n${segments.map((s, i) => `${i + 1}. [${s.type.toUpperCase()}] "${s.text.substring(0, 80)}..." — ${(s.similarity * 100).toFixed(0)}% similar\n   Source: ${s.source}\n   ${s.source_url}`).join('\n\n')}` : 'No plagiarism matches detected.'}

RECOMMENDATIONS:
${suggestions.map(s => `• ${s.text}`).join('\n')}

${'─'.repeat(60)}
Engine: PlagiScan AI v2 Local Engine (no external API keys)
Algorithms: TF-IDF, Cosine, Jaccard, N-gram, LCS, Winnowing
Sources checked: ${contentCache.size} | Sensitivity: ${sensitivity}`;

    streamLog(requestId, `\n${'═'.repeat(60)}`);
    streamLog(requestId, `✅ Done: ${similarityScore}% similarity, ${segments.length} flagged, ${srcList.length} sources`);
    streamLog(requestId, `🤖 AI Detection: ${aiDetection.score}% — ${aiDetection.verdict}`);
    streamLog(requestId, `📦 Cache: ${contentCache.size} articles checked`);
    streamLog(requestId, `${'═'.repeat(60)}\n`);

    res.json({
      similarity_score: similarityScore,
      original_score: originalScore,
      verdict, verdict_level: verdictLevel,
      verdict_description: verdictDesc,
      word_count: totalWords,
      sentence_count: allSentences.length,
      flagged_phrases: segments.length,
      sources_found: srcList.length,
      ai_detection: { score: aiDetection.score, verdict: aiDetection.verdict, level: aiDetection.level, confidence: aiDetection.confidence, metrics: aiDetection.metrics },
      segments: segments.map(s => ({ text: s.text, type: s.type, reason: s.reason, source: s.source, source_url: s.source_url })),
      sources: srcList, suggestions, full_report: fullReport,
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: { message: 'Analysis failed: ' + err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`\n  🔍 PlagiScan AI v2 — Full Local Engine`);
  console.log(`  ➜  http://localhost:${PORT}/PlagiaScanAI%20-%20Check%20Plagiarism.html`);
  console.log(`  ✦  No API key needed — Wikipedia + Crossref + Scholar + DDG + OpenLib`);
  console.log(`  🤖 AI-written content detection included`);
  console.log(`  🧠 Algorithms: TF-IDF, Cosine, Jaccard, N-gram, LCS, Winnowing\n`);
});
