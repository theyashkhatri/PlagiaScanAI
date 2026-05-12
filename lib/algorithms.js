// ═══════════════════════════════════════════════════════════
// PLAGISCAN AI — Advanced Similarity Algorithms
// TF-IDF, Cosine Similarity, LCS, Winnowing, Composite
// ═══════════════════════════════════════════════════════════

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'and','but','or','nor','not','so','yet','both','either','neither','each','every',
  'all','any','few','more','most','other','some','such','no','only','own','same','than',
  'too','very','just','also','of','in','to','for','with','on','at','from','by','about',
  'as','into','through','during','before','after','above','below','between','under',
  'again','further','then','once','here','there','when','where','why','how','what',
  'which','who','whom','this','that','these','those','it','its','they','them','their',
  'we','us','our','he','him','his','she','her','i','me','my','you','your']);

function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(s => s.length > 1);
}

function tokenizeFiltered(text) {
  return tokenize(text).filter(w => !STOPWORDS.has(w) && w.length > 2);
}

// ─── TF-IDF + Cosine Similarity ────────────────────────────

function computeTF(words) {
  const tf = {};
  words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });
  const len = words.length || 1;
  for (const w in tf) tf[w] /= len;
  return tf;
}

function computeIDF(documents) {
  const idf = {};
  const N = documents.length;
  documents.forEach(doc => {
    const seen = new Set(doc);
    seen.forEach(w => { idf[w] = (idf[w] || 0) + 1; });
  });
  for (const w in idf) idf[w] = Math.log((N + 1) / (idf[w] + 1)) + 1;
  return idf;
}

function tfidfVector(words, idf) {
  const tf = computeTF(words);
  const vec = {};
  for (const w in tf) {
    vec[w] = tf[w] * (idf[w] || Math.log(2));
  }
  return vec;
}

function cosineSimilarity(vec1, vec2) {
  const allKeys = new Set([...Object.keys(vec1), ...Object.keys(vec2)]);
  let dot = 0, mag1 = 0, mag2 = 0;
  allKeys.forEach(k => {
    const a = vec1[k] || 0, b = vec2[k] || 0;
    dot += a * b;
    mag1 += a * a;
    mag2 += b * b;
  });
  const denom = Math.sqrt(mag1) * Math.sqrt(mag2);
  return denom === 0 ? 0 : dot / denom;
}

function tfidfCosineSimilarity(text1, text2) {
  const words1 = tokenizeFiltered(text1);
  const words2 = tokenizeFiltered(text2);
  if (words1.length < 3 || words2.length < 3) return 0;
  const idf = computeIDF([words1, words2]);
  const v1 = tfidfVector(words1, idf);
  const v2 = tfidfVector(words2, idf);
  return cosineSimilarity(v1, v2);
}

// ─── Longest Common Subsequence (LCS) ─────────────────────

function lcsRatio(text1, text2) {
  const w1 = tokenize(text1);
  const w2 = tokenize(text2);
  if (w1.length === 0 || w2.length === 0) return 0;

  // Optimize: use shorter text as rows
  const short = w1.length <= w2.length ? w1 : w2;
  const long = w1.length <= w2.length ? w2 : w1;

  // Space-optimized LCS using 2 rows
  let prev = new Array(long.length + 1).fill(0);
  let curr = new Array(long.length + 1).fill(0);

  for (let i = 1; i <= short.length; i++) {
    for (let j = 1; j <= long.length; j++) {
      if (short[i - 1] === long[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  const lcsLen = prev[long.length];
  // Dice-style normalization: prevents inflation when one text is much longer
  return (2 * lcsLen) / (w1.length + w2.length);
}

// ─── Winnowing Fingerprinting ──────────────────────────────

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function kgramHashes(text, k = 5) {
  const words = tokenize(text);
  if (words.length < k) return [];
  const hashes = [];
  for (let i = 0; i <= words.length - k; i++) {
    hashes.push(hashString(words.slice(i, i + k).join(' ')));
  }
  return hashes;
}

function winnow(hashes, windowSize = 4) {
  if (hashes.length === 0) return new Set();
  const fingerprints = new Set();
  for (let i = 0; i <= hashes.length - windowSize; i++) {
    const window = hashes.slice(i, i + windowSize);
    fingerprints.add(Math.min(...window));
  }
  return fingerprints;
}

function winnowingSimilarity(text1, text2, k = 5, w = 4) {
  const h1 = kgramHashes(text1, k);
  const h2 = kgramHashes(text2, k);
  const fp1 = winnow(h1, w);
  const fp2 = winnow(h2, w);
  if (fp1.size === 0 || fp2.size === 0) return 0;
  let intersection = 0;
  fp1.forEach(f => { if (fp2.has(f)) intersection++; });
  return intersection / Math.min(fp1.size, fp2.size);
}

// ─── Existing: Jaccard + N-gram ────────────────────────────

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
  const matched = [...ngrams1].filter(x => ngrams2.has(x));
  return ngrams1.size === 0 ? 0 : matched.length / ngrams1.size;
}

// ─── Composite Scorer ──────────────────────────────────────

function compositeScore(text1, text2) {
  const minLen = Math.min(tokenize(text1).length, tokenize(text2).length);

  // For very short comparisons, fingerprinting metrics need token mass to work —
  // fall back to a tfidf-heavy blend that stays reliable at low token counts
  if (minLen < 15) {
    return (
      tfidfCosineSimilarity(text1, text2) * 0.55 +
      jaccardSimilarity(text1, text2)     * 0.10 +
      ngramOverlap(text1, text2, 2)       * 0.20 +
      lcsRatio(text1, text2)              * 0.15
    );
  }

  const jaccard   = jaccardSimilarity(text1, text2);
  const bigram    = ngramOverlap(text1, text2, 2);
  const trigram   = ngramOverlap(text1, text2, 3);
  const fourgram  = ngramOverlap(text1, text2, 4);
  const tfidf     = tfidfCosineSimilarity(text1, text2);
  const lcs       = lcsRatio(text1, text2);
  const winnowing = winnowingSimilarity(text1, text2);

  // TF-IDF boosted for paraphrase detection; fingerprinting retained as verbatim anchor
  return (
    jaccard   * 0.04 +
    bigram    * 0.08 +
    trigram   * 0.08 +
    fourgram  * 0.03 +
    tfidf     * 0.55 +
    lcs       * 0.14 +
    winnowing * 0.08
  );
}

module.exports = {
  tokenize, tokenizeFiltered, STOPWORDS,
  tfidfCosineSimilarity, cosineSimilarity, computeIDF, tfidfVector, computeTF,
  lcsRatio,
  winnowingSimilarity, kgramHashes, winnow,
  jaccardSimilarity, ngramOverlap,
  compositeScore,
};
