// ═══════════════════════════════════════════════════════════
// PLAGISCAN AI — AI-Written Content Detection (Local)
// Statistical analysis — no external API needed
// ═══════════════════════════════════════════════════════════

function extractSentences(text) {
  return text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 10);
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(s => s.length > 1);
}

// ─── 1. Vocabulary Richness (Type-Token Ratio) ────────────
function vocabularyRichness(text) {
  const words = tokenize(text);
  if (words.length < 150) return { score: 0, detail: 'Text too short (need 150+ words)' };
  const unique = new Set(words).size;
  const ttr = unique / words.length;
  // AI text typically has TTR 0.35-0.50, human text 0.50-0.75
  // Normalize: lower TTR = more likely AI
  const aiLikelihood = Math.max(0, Math.min(100, (0.65 - ttr) * 250));
  return { score: aiLikelihood, ttr: ttr.toFixed(3), detail: `TTR: ${ttr.toFixed(3)} (${ttr < 0.45 ? 'low — typical of AI' : ttr < 0.55 ? 'moderate' : 'high — likely human'})` };
}

// ─── 2. Sentence Length Variance ───────────────────────────
function sentenceLengthVariance(text) {
  const sentences = extractSentences(text);
  if (sentences.length < 8) return { score: 0, detail: 'Not enough sentences (need 8+)' };
  const lengths = sentences.map(s => s.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, l) => a + (l - mean) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / (mean || 1); // Coefficient of variation
  // AI text: CV typically 0.15-0.35, Human: 0.35-0.80
  const aiLikelihood = Math.max(0, Math.min(100, (0.50 - cv) * 200));
  return { score: aiLikelihood, stdDev: stdDev.toFixed(2), cv: cv.toFixed(3), detail: `CV: ${cv.toFixed(3)} (${cv < 0.30 ? 'uniform — typical of AI' : cv < 0.45 ? 'moderate' : 'varied — likely human'})` };
}

// ─── 3. Burstiness Score ───────────────────────────────────
function burstinessScore(text) {
  const sentences = extractSentences(text);
  if (sentences.length < 8) return { score: 0, detail: 'Not enough sentences (need 8+)' };
  const lengths = sentences.map(s => s.split(/\s+/).length);
  let changes = 0;
  for (let i = 1; i < lengths.length; i++) {
    changes += Math.abs(lengths[i] - lengths[i - 1]);
  }
  const avgChange = changes / (lengths.length - 1);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const burstiness = avgChange / (mean || 1);
  // Low burstiness = AI (monotone rhythm), High = human (natural variation)
  const aiLikelihood = Math.max(0, Math.min(100, (0.55 - burstiness) * 200));
  return { score: aiLikelihood, burstiness: burstiness.toFixed(3), detail: `Burstiness: ${burstiness.toFixed(3)} (${burstiness < 0.35 ? 'low — AI pattern' : burstiness < 0.55 ? 'moderate' : 'high — natural writing'})` };
}

// ─── 4. Zipf's Law Deviation ───────────────────────────────
function zipfDeviation(text) {
  const words = tokenize(text);
  if (words.length < 100) return { score: 0, detail: 'Text too short (need 100+ words)' };
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const sorted = Object.values(freq).sort((a, b) => b - a);
  const topFreq = sorted[0];
  // Zipf's law: frequency of rank r ≈ topFreq / r
  let deviation = 0;
  const limit = Math.min(sorted.length, 20);
  for (let r = 1; r <= limit; r++) {
    const expected = topFreq / r;
    const actual = sorted[r - 1] || 0;
    deviation += Math.abs(actual - expected) / (expected || 1);
  }
  deviation /= limit;
  // AI text tends to have LOWER deviation from Zipf (too "perfect")
  const aiLikelihood = Math.max(0, Math.min(100, (1.0 - deviation) * 70));
  return { score: aiLikelihood, deviation: deviation.toFixed(3), detail: `Zipf deviation: ${deviation.toFixed(3)} (${deviation < 0.5 ? 'low — unnaturally smooth' : deviation < 1.0 ? 'moderate' : 'high — natural distribution'})` };
}

// ─── 5. Transition Word Density ────────────────────────────
function transitionDensity(text) {
  const transitions = [
    // Classic connectives
    'furthermore','moreover','additionally','consequently','therefore','however',
    'nevertheless','meanwhile','subsequently','accordingly','in addition',
    'as a result','on the other hand','in contrast','for instance','for example',
    'in conclusion','to summarize','it is important','it is worth noting',
    'it is crucial','it should be noted','this suggests','this indicates',
    'this demonstrates','in particular','specifically','notably','significantly',
    'interestingly','ultimately','fundamentally','essentially','overall',
    // AI structural openers (topic-sentence patterns)
    'despite','despite the','despite these','despite this',
    'by leveraging','by enabling','by using','by integrating',
    'this has led','this allows','this enables','this helps',
    'plays a crucial','plays an important','plays a key','plays a vital',
    'has the potential','have the potential',
    'has become','have become','has also','have also',
    'can be used','can also be','can help',
  ];
  const lower = text.toLowerCase();
  const sentences = extractSentences(text);
  if (sentences.length < 3) return { score: 0, detail: 'Not enough sentences' };
  let count = 0;
  transitions.forEach(t => {
    const regex = new RegExp('\\b' + t.replace(/\s+/g, '\\s+') + '\\b', 'gi');
    const matches = lower.match(regex);
    if (matches) count += matches.length;
  });
  const density = count / sentences.length;
  // Rescaled: AI text at 0.15-0.50, human at 0.05-0.15. Score peaks at density 0.5.
  const aiLikelihood = Math.max(0, Math.min(100, density * 200));
  return { score: aiLikelihood, density: density.toFixed(3), count, detail: `${count} transitions in ${sentences.length} sentences (density: ${density.toFixed(2)} — ${density > 0.30 ? 'high — AI pattern' : density > 0.15 ? 'moderate' : 'normal'})` };
}

// ─── 8. Structural Topic-Sentence Pattern ─────────────────
function structuralPatternScore(text) {
  const sentences = extractSentences(text);
  if (sentences.length < 4) return { score: 0, detail: 'Not enough sentences' };

  // AI models frequently open sentences with "[Domain noun] [has/is/are/can/also]"
  // or prepositional topic frames like "In X, Y" / "From X to Y, Z"
  const topicFramePattern = /^(in |from |for |by |with |through |across |among |between |beyond |despite |during |given |unlike |regarding )/i;
  const beVerbOpenPattern = /^[A-Z][a-z]+ (has|have|is|are|can|also|was|were|will|may|might|must|should|could|would)\b/;
  const passiveOpenPattern = /^[A-Z][a-z]+ (has been|have been|is being|are being|was|were) /;

  let topicFrames = 0;
  let beVerbOpens = 0;
  let passiveOpens = 0;

  for (const s of sentences) {
    if (topicFramePattern.test(s)) topicFrames++;
    else if (beVerbOpenPattern.test(s)) beVerbOpens++;
    if (passiveOpenPattern.test(s)) passiveOpens++;
  }

  const topicRate = topicFrames / sentences.length;
  const beVerbRate = beVerbOpens / sentences.length;
  const passiveRate = passiveOpens / sentences.length;

  // AI writing: high proportion of topic-framed and be-verb-opened sentences
  const combined = (topicRate * 0.5 + beVerbRate * 0.35 + passiveRate * 0.15);
  const aiLikelihood = Math.max(0, Math.min(100, combined * 250));
  return {
    score: aiLikelihood,
    detail: `Topic frames: ${topicFrames}/${sentences.length}, Be-verb opens: ${beVerbOpens}/${sentences.length} (${aiLikelihood > 50 ? 'structured — AI pattern' : aiLikelihood > 25 ? 'moderate' : 'natural'})`,
  };
}

// ─── 6. Repetition Patterns ───────────────────────────────
function repetitionPatterns(text) {
  const words = tokenize(text);
  if (words.length < 100) return { score: 0, detail: 'Text too short (need 100+ words)' };
  // Check for repeated 3-grams across the document
  const trigrams = {};
  for (let i = 0; i <= words.length - 3; i++) {
    const tri = words.slice(i, i + 3).join(' ');
    trigrams[tri] = (trigrams[tri] || 0) + 1;
  }
  const repeated = Object.values(trigrams).filter(c => c > 1);
  const repetitionRate = repeated.length / (Object.keys(trigrams).length || 1);
  // Also check for repeated sentence starters
  const sentences = extractSentences(text);
  const starters = sentences.map(s => s.split(/\s+/).slice(0, 2).join(' ').toLowerCase());
  const starterSet = new Set(starters);
  const starterRepRate = 1 - (starterSet.size / (starters.length || 1));
  const combined = (repetitionRate * 0.5 + starterRepRate * 0.5);
  const aiLikelihood = Math.max(0, Math.min(100, combined * 300));
  return { score: aiLikelihood, repetitionRate: repetitionRate.toFixed(3), detail: `Repetition rate: ${repetitionRate.toFixed(3)}, Starter repeat: ${(starterRepRate * 100).toFixed(0)}%` };
}

// ─── 7. Character Entropy ──────────────────────────────────
function characterEntropy(text) {
  if (text.length < 50) return { score: 0, detail: 'Text too short' };
  const clean = text.toLowerCase().replace(/\s+/g, ' ');
  const freq = {};
  for (const c of clean) freq[c] = (freq[c] || 0) + 1;
  const len = clean.length;
  let entropy = 0;
  for (const c in freq) {
    const p = freq[c] / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  // English text: ~4.0-4.5 bits. AI text tends toward 4.0-4.2 (more predictable)
  const aiLikelihood = Math.max(0, Math.min(100, (4.35 - entropy) * 150));
  return { score: aiLikelihood, entropy: entropy.toFixed(3), detail: `Entropy: ${entropy.toFixed(3)} bits (${entropy < 4.1 ? 'low — predictable' : entropy < 4.3 ? 'moderate' : 'high — natural variance'})` };
}

// ─── Composite AI Detection ────────────────────────────────
function detectAIWritten(text) {
  const metrics = {
    vocabularyRichness: vocabularyRichness(text),
    sentenceLengthVariance: sentenceLengthVariance(text),
    burstiness: burstinessScore(text),
    zipfDeviation: zipfDeviation(text),
    transitionDensity: transitionDensity(text),
    repetitionPatterns: repetitionPatterns(text),
    characterEntropy: characterEntropy(text),
    structuralPattern: structuralPatternScore(text),
  };

  // Base weights — metrics that returned score:0 due to short-text guards are
  // excluded from the weighted average so they don't drag the score down
  const baseWeights = {
    vocabularyRichness: 0.12,
    sentenceLengthVariance: 0.13,
    burstiness: 0.13,
    zipfDeviation: 0.08,
    transitionDensity: 0.18,
    repetitionPatterns: 0.08,
    characterEntropy: 0.13,
    structuralPattern: 0.15,
  };

  // Only include metrics that actually computed a score (guard didn't fire)
  const activeKeys = Object.keys(baseWeights).filter(k => metrics[k].detail && !metrics[k].detail.includes('too short') && !metrics[k].detail.includes('Not enough'));
  const totalWeight = activeKeys.reduce((sum, k) => sum + baseWeights[k], 0);

  let totalScore = 0;
  if (totalWeight > 0) {
    for (const key of activeKeys) {
      totalScore += (metrics[key].score || 0) * (baseWeights[key] / totalWeight);
    }
  }
  totalScore = Math.round(Math.max(0, Math.min(100, totalScore)));

  // Confidence reflects how many metrics were usable
  const words = text.split(/\s+/).length;
  const sentences = extractSentences(text).length;
  let confidence;
  if (words < 150 || sentences < 8) confidence = 'low';
  else if (activeKeys.length >= 5) confidence = 'high';
  else confidence = 'moderate';

  let verdict, level;
  if (totalScore >= 70) { verdict = 'Likely AI-Generated'; level = 'high'; }
  else if (totalScore >= 40) { verdict = 'Possibly AI-Assisted'; level = 'medium'; }
  else { verdict = 'Likely Human-Written'; level = 'low'; }

  return { score: totalScore, verdict, level, confidence, metrics };
}

module.exports = { detectAIWritten };
