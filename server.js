const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════════════════════════
// PLAGISCAN AI — REAL PLAGIARISM ENGINE
// Uses Wikipedia API + Crossref API (both free, no key)
// ═══════════════════════════════════════════════════════════

// ─── Text Utilities ────────────────────────────────────────

function extractSentences(text) {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.split(/\s+/).length >= 4);
}

function selectKeySentences(sentences, max = 6) {
  return sentences
    .map(s => ({ text: s, wordCount: s.split(/\s+/).length }))
    .filter(s => s.wordCount >= 5)
    .sort((a, b) => b.wordCount - a.wordCount)
    .slice(0, max)
    .map(s => s.text);
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(s => s.length > 1);
}

function extractKeywords(text, count = 5) {
  const stopwords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','shall','should','may','might','must','can','could',
    'and','but','or','nor','not','so','yet','both','either','neither','each','every',
    'all','any','few','more','most','other','some','such','no','only','own','same','than',
    'too','very','just','also','of','in','to','for','with','on','at','from','by','about',
    'as','into','through','during','before','after','above','below','between','under',
    'again','further','then','once','here','there','when','where','why','how','what',
    'which','who','whom','this','that','these','those','it','its','they','them','their',
    'we','us','our','he','him','his','she','her','i','me','my','you','your']);
  const words = tokenize(text);
  const freq = {};
  words.forEach(w => { if (!stopwords.has(w) && w.length > 3) freq[w] = (freq[w] || 0) + 1; });
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}

// ─── Similarity Scoring ────────────────────────────────────

function jaccardSimilarity(text1, text2) {
  const set1 = new Set(tokenize(text1));
  const set2 = new Set(tokenize(text2));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function ngramOverlap(text1, text2, n) {
  const words1 = tokenize(text1);
  const words2 = tokenize(text2);
  if (words1.length < n || words2.length < n) return 0;
  const ngrams1 = new Set();
  const ngrams2 = new Set();
  for (let i = 0; i <= words1.length - n; i++) ngrams1.add(words1.slice(i, i + n).join(' '));
  for (let i = 0; i <= words2.length - n; i++) ngrams2.add(words2.slice(i, i + n).join(' '));
  const intersection = [...ngrams1].filter(x => ngrams2.has(x));
  return ngrams1.size === 0 ? 0 : intersection.length / ngrams1.size;
}

function scorePair(text1, text2) {
  const jaccard = jaccardSimilarity(text1, text2);
  const bigram = ngramOverlap(text1, text2, 2);
  const trigram = ngramOverlap(text1, text2, 3);
  const fourgram = ngramOverlap(text1, text2, 4);
  return jaccard * 0.15 + bigram * 0.20 + trigram * 0.30 + fourgram * 0.35;
}

function splitIntoChunks(text) {
  // Split article into sentences for fine-grained comparison
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 15);
  
  // Also create sliding windows of 2-3 consecutive sentences (catches multi-sentence plagiarism)
  const chunks = [...sentences];
  for (let i = 0; i < sentences.length - 1; i++) {
    chunks.push(sentences[i] + ' ' + sentences[i + 1]);
  }
  for (let i = 0; i < sentences.length - 2; i++) {
    chunks.push(sentences[i] + ' ' + sentences[i + 1] + ' ' + sentences[i + 2]);
  }
  return chunks;
}

function computeSimilarity(inputSentence, sourceText) {
  // If source is short, compare directly
  if (sourceText.length < 300) {
    return scorePair(inputSentence, sourceText);
  }
  
  // Split source into sentences/chunks and find the best match
  const chunks = splitIntoChunks(sourceText);
  let bestScore = 0;
  for (const chunk of chunks) {
    const score = scorePair(inputSentence, chunk);
    if (score > bestScore) bestScore = score;
    // Early exit if we found a very strong match
    if (bestScore > 0.7) break;
  }
  return bestScore;
}

// ─── Wikipedia API (Free, No Key) ──────────────────────────

async function searchWikipedia(query) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=5&srprop=snippet|titlesnippet|sectionsnippet`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'PlagiScanAI/1.0 (Academic Project; Plagiarism Detection)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.query?.search || []).map(r => ({
      title: r.title,
      snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    }));
  } catch (err) {
    console.log(`    ⚠ Wikipedia search error: ${err.message}`);
    return [];
  }
}

async function getWikipediaContent(title) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=0&explaintext=1&format=json&exsectionformat=plain&exchars=3000`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'PlagiScanAI/1.0 (Academic Project; Plagiarism Detection)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return '';
    const data = await response.json();
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    return page?.extract || '';
  } catch (err) {
    return '';
  }
}

// ─── Crossref API (Free, No Key) for Academic Papers ───────

async function searchCrossref(query) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=3&select=title,abstract,URL,DOI`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'PlagiScanAI/1.0 (mailto:plagiscan@academic.project)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.message?.items || [])
      .filter(item => item.abstract || item.title)
      .map(item => ({
        title: (item.title || [''])[0],
        snippet: (item.abstract || '').replace(/<[^>]+>/g, '').substring(0, 500),
        url: item.URL || `https://doi.org/${item.DOI}`,
      }));
  } catch (err) {
    console.log(`    ⚠ Crossref error: ${err.message}`);
    return [];
  }
}

// ─── Delay helper ──────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main Analysis Endpoint ────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, sensitivity = 'standard', options = {} } = req.body;

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: { message: 'Text too short. Need at least 50 characters.' } });
    }

    const inputText = text.trim();
    const allSentences = extractSentences(inputText);
    const keySentences = selectKeySentences(allSentences);
    const totalWords = tokenize(inputText).length;
    const keywords = extractKeywords(inputText, 5);

    console.log(`\n📝 Analyzing ${totalWords} words, ${allSentences.length} sentences`);
    console.log(`🔑 Keywords: ${keywords.join(', ')}`);
    console.log(`🔍 Checking ${keySentences.length} key sentences...\n`);

    const segments = [];
    const sourceMap = {};
    let totalFlaggedWords = 0;
    const checkedArticles = new Map(); // Cache Wikipedia content

    // Phase 1: Search Wikipedia for each key sentence
    for (let i = 0; i < keySentences.length; i++) {
      const sentence = keySentences[i];
      const searchQuery = sentence.split(/\s+/).slice(0, 10).join(' ');
      console.log(`  [${i + 1}/${keySentences.length}] "${searchQuery.substring(0, 55)}..."`);

      // Search Wikipedia
      const wikiResults = await searchWikipedia(searchQuery);
      console.log(`    📚 Wikipedia: ${wikiResults.length} articles found`);

      // Search Crossref for academic papers
      let crossrefResults = [];
      if (options.academic !== false) {
        crossrefResults = await searchCrossref(sentence.split(/\s+/).slice(0, 8).join(' '));
        console.log(`    🎓 Crossref: ${crossrefResults.length} papers found`);
      }

      const allResults = [...wikiResults, ...crossrefResults];
      let bestMatch = null;
      let bestScore = 0;

      for (const result of allResults) {
        // First check snippet similarity
        let contentToCompare = result.snippet;

        // For Wikipedia results, fetch full article content for better comparison
        if (result.url.includes('wikipedia.org') && !checkedArticles.has(result.title)) {
          const fullContent = await getWikipediaContent(result.title);
          if (fullContent) {
            checkedArticles.set(result.title, fullContent);
            contentToCompare = fullContent;
          }
        } else if (checkedArticles.has(result.title)) {
          contentToCompare = checkedArticles.get(result.title);
        }

        if (!contentToCompare || contentToCompare.length < 20) continue;

        // Compare the sentence against the source content
        const score = computeSimilarity(sentence, contentToCompare);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = { ...result, score };
        }
      }

      // Sensitivity-based thresholds
      const threshold = sensitivity === 'strict' ? 0.08 : sensitivity === 'lenient' ? 0.25 : 0.12;

      if (bestMatch && bestScore >= threshold) {
        const sentenceWords = sentence.split(/\s+/).length;
        let type, reason;

        if (bestScore >= 0.40) {
          type = 'high';
          reason = `High similarity (${(bestScore * 100).toFixed(0)}%) — matches content from: ${bestMatch.title}`;
          totalFlaggedWords += sentenceWords;
        } else if (bestScore >= 0.25) {
          type = 'medium';
          reason = `Moderate similarity (${(bestScore * 100).toFixed(0)}%) — overlaps with: ${bestMatch.title}`;
          totalFlaggedWords += Math.round(sentenceWords * 0.7);
        } else {
          type = 'paraphrase';
          reason = `Possible paraphrase (${(bestScore * 100).toFixed(0)}% similar) from: ${bestMatch.title}`;
          totalFlaggedWords += Math.round(sentenceWords * 0.4);
        }

        const displayText = sentence.length > 150 ? sentence.substring(0, 147) + '...' : sentence;
        console.log(`    ✓ MATCH [${type}] ${(bestScore*100).toFixed(0)}% → ${bestMatch.title.substring(0, 40)}`);

        segments.push({
          text: displayText, type, reason,
          source: bestMatch.title,
          source_url: bestMatch.url,
          similarity: bestScore,
        });

        // Track sources
        const srcKey = bestMatch.title;
        if (!sourceMap[srcKey]) {
          sourceMap[srcKey] = { title: bestMatch.title, url: bestMatch.url, matchedWords: 0, matchCount: 0, bestScore: 0 };
        }
        sourceMap[srcKey].matchedWords += sentenceWords;
        sourceMap[srcKey].matchCount++;
        if (bestScore > sourceMap[srcKey].bestScore) sourceMap[srcKey].bestScore = bestScore;
      } else {
        console.log(`    ○ No significant match`);
      }

      // Small delay to be respectful to APIs
      if (i < keySentences.length - 1) await delay(500);
    }

    // ── Phase 2: Keyword-based Wikipedia deep scan ──
    console.log(`\n  📖 Deep scanning Wikipedia for keyword matches...`);
    for (const keyword of keywords.slice(0, 3)) {
      if (checkedArticles.has(keyword)) continue;
      const content = await getWikipediaContent(keyword);
      if (content && content.length > 100) {
        checkedArticles.set(keyword, content);
        // Check ALL sentences against this article
        for (const sentence of allSentences) {
          const alreadyFlagged = segments.some(s => s.text.includes(sentence.substring(0, 30)));
          if (alreadyFlagged) continue;
          
          const score = computeSimilarity(sentence, content);
          const threshold = sensitivity === 'strict' ? 0.10 : sensitivity === 'lenient' ? 0.25 : 0.14;
          
          if (score >= threshold) {
            const sentenceWords = sentence.split(/\s+/).length;
            let type = score >= 0.40 ? 'high' : score >= 0.25 ? 'medium' : 'paraphrase';
            totalFlaggedWords += type === 'high' ? sentenceWords : type === 'medium' ? Math.round(sentenceWords * 0.7) : Math.round(sentenceWords * 0.4);

            const displayText = sentence.length > 150 ? sentence.substring(0, 147) + '...' : sentence;
            const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(keyword.replace(/ /g, '_'))}`;
            console.log(`    ✓ Deep match [${type}] ${(score*100).toFixed(0)}% in "${keyword}" article`);

            segments.push({
              text: displayText, type,
              reason: `${type === 'high' ? 'High' : type === 'medium' ? 'Moderate' : 'Possible'} similarity (${(score*100).toFixed(0)}%) with Wikipedia: ${keyword}`,
              source: `Wikipedia: ${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`,
              source_url: wikiUrl,
              similarity: score,
            });

            if (!sourceMap[keyword]) {
              sourceMap[keyword] = { title: `Wikipedia: ${keyword}`, url: wikiUrl, matchedWords: 0, matchCount: 0, bestScore: 0 };
            }
            sourceMap[keyword].matchedWords += sentenceWords;
            sourceMap[keyword].matchCount++;
            if (score > sourceMap[keyword].bestScore) sourceMap[keyword].bestScore = score;
          }
        }
      }
      await delay(300);
    }

    // ── Calculate final scores ──
    const similarityScore = Math.min(100, Math.round((totalFlaggedWords / (totalWords || 1)) * 100));
    const originalScore = 100 - similarityScore;

    // ── Verdict ──
    let verdict, verdictLevel, verdictDesc;
    if (similarityScore > 50) {
      verdict = 'Highly Plagiarized';
      verdictLevel = 'high';
      verdictDesc = `Significant matches found: ${similarityScore}% of content matches existing sources. ${segments.length} passage(s) flagged from ${Object.keys(sourceMap).length} source(s). Major revision with citations is strongly recommended.`;
    } else if (similarityScore > 25) {
      verdict = 'Moderate Plagiarism';
      verdictLevel = 'medium';
      verdictDesc = `Moderate similarity (${similarityScore}%) detected with published sources. ${segments.length} passage(s) flagged. Review highlighted sections and add proper citations.`;
    } else if (similarityScore > 10) {
      verdict = 'Minor Plagiarism';
      verdictLevel = 'low';
      verdictDesc = `Minor similarity (${similarityScore}%) detected. ${segments.length} passage(s) resemble existing content. Typical for academic writing; minor revisions may help.`;
    } else {
      verdict = 'Mostly Original';
      verdictLevel = 'low';
      verdictDesc = `The text appears highly original (${originalScore}% unique). ${segments.length === 0 ? 'No' : 'Minimal'} matches with published sources. Good originality demonstrated.`;
    }

    // ── Sources ──
    const sources = Object.values(sourceMap)
      .map(s => ({
        title: s.title,
        url: s.url,
        match_percent: Math.min(100, Math.round((s.matchedWords / (totalWords || 1)) * 100)),
        match_level: s.bestScore >= 0.50 ? 'high' : s.bestScore >= 0.30 ? 'medium' : 'low',
      }))
      .sort((a, b) => b.match_percent - a.match_percent)
      .slice(0, 10);

    // ── Suggestions ──
    const suggestions = [];
    const highSegs = segments.filter(s => s.type === 'high');
    const medSegs = segments.filter(s => s.type === 'medium');
    const paraSegs = segments.filter(s => s.type === 'paraphrase');

    if (highSegs.length > 0)
      suggestions.push({ type: 'high', text: `${highSegs.length} passage(s) closely match published sources. These must be quoted with citations or rewritten entirely.` });
    if (medSegs.length > 0)
      suggestions.push({ type: 'medium', text: `${medSegs.length} passage(s) show moderate overlap. Add citations for borrowed ideas and phrases.` });
    if (paraSegs.length > 0)
      suggestions.push({ type: 'info', text: `${paraSegs.length} passage(s) may be paraphrased. Even paraphrased content requires citing the original source.` });
    if (similarityScore < 15)
      suggestions.push({ type: 'good', text: 'Good originality. The text does not significantly match known published content.' });
    if (segments.length === 0)
      suggestions.push({ type: 'good', text: 'No matching sources found. The content appears to be original work.' });

    // ── Full Report ──
    const fullReport = `PLAGISCAN AI — PLAGIARISM ANALYSIS REPORT
Generated: ${new Date().toLocaleString()}

DOCUMENT OVERVIEW:
Analyzed ${totalWords} words across ${allSentences.length} sentences. ${keySentences.length} key sentences were searched against Wikipedia (${checkedArticles.size} articles checked) and Crossref academic databases.

METHODOLOGY:
Real-time comparison against Wikipedia articles and Crossref academic papers using multi-metric similarity analysis (Jaccard coefficient + 2/3/4-gram fingerprinting). Sensitivity: ${sensitivity} mode.

RESULTS:
Similarity: ${similarityScore}% | Originality: ${originalScore}%
Verdict: ${verdict}
Flagged: ${segments.length} passages | Sources: ${sources.length}

${verdictDesc}

${segments.length > 0 ? `FLAGGED PASSAGES:\n${segments.map((s, i) => `${i+1}. [${s.type.toUpperCase()}] "${s.text.substring(0, 80)}..." — ${(s.similarity*100).toFixed(0)}% similar\n   Source: ${s.source}\n   ${s.source_url}`).join('\n\n')}` : 'No matches detected.'}

RECOMMENDATIONS:
${suggestions.map(s => `• ${s.text}`).join('\n')}

NOTE: This report checks against Wikipedia and Crossref. For institutional papers, use Turnitin.`;

    console.log(`\n✅ Done: ${similarityScore}% similarity, ${segments.length} flagged, ${sources.length} sources, ${checkedArticles.size} articles checked\n`);

    res.json({
      similarity_score: similarityScore,
      original_score: originalScore,
      verdict, verdict_level: verdictLevel,
      verdict_description: verdictDesc,
      word_count: totalWords,
      sentence_count: allSentences.length,
      flagged_phrases: segments.length,
      sources_found: sources.length,
      segments: segments.map(s => ({ text: s.text, type: s.type, reason: s.reason, source: s.source, source_url: s.source_url })),
      sources, suggestions, full_report: fullReport,
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: { message: 'Analysis failed: ' + err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`\n  🔍 PlagiScan AI server running at:`);
  console.log(`  ➜  http://localhost:${PORT}/plagiarism-checker.html`);
  console.log(`  ✦  Wikipedia + Crossref engine — no API key needed\n`);
});
